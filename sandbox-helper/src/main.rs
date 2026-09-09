use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use std::env;
#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};
#[cfg(not(target_os = "windows"))]
use std::process::Command;
#[cfg(not(target_os = "windows"))]
use std::process::Stdio;

const PROTOCOL_VERSION: &str = "1";

#[derive(Debug, Deserialize)]
struct ExecutionRequest {
    workspace_root: String,
    executable: String,
    args: Vec<String>,
    cwd: String,
    env: std::collections::BTreeMap<String, String>,
    timeout_ms: u64,
    max_stdout_bytes: u64,
    max_stderr_bytes: u64,
    network: String,
}

fn main() {
    let result = match env::args().nth(1).as_deref() {
        Some("--capabilities") => capabilities(),
        Some("--execute") => execute(env::args().nth(2)),
        _ => Err("invalid helper invocation".to_string()),
    };
    if let Err(error) = result {
        eprintln!("sandbox-helper: {error}");
        std::process::exit(125);
    }
}

fn capabilities() -> Result<(), String> {
    #[allow(unused_mut)]
    let mut values = vec!["process.spawn", "process-tree", "workspace.fs"];
    #[cfg(target_os = "linux")]
    if namespace_probe() {
        values.push("network.off");
        values.push("os.isolation");
    }
    #[cfg(target_os = "windows")]
    if windows_isolation_probe() {
        values.push("network.off");
        values.push("os.isolation");
    }
    println!(
        "{}",
        serde_json::json!({
            "backend": "rust-helper",
            "version": PROTOCOL_VERSION,
            "capabilities": values,
        })
    );
    Ok(())
}

fn execute(encoded: Option<String>) -> Result<(), String> {
    let encoded = encoded.ok_or_else(|| "missing encoded request".to_string())?;
    let bytes = STANDARD.decode(encoded).map_err(|_| "invalid request encoding".to_string())?;
    let request: ExecutionRequest = serde_json::from_slice(&bytes).map_err(|_| "invalid request JSON".to_string())?;
    validate(&request)?;

    #[cfg(target_os = "windows")]
    { return execute_windows(&request); }
    #[cfg(not(target_os = "windows"))]
    {
        let mut command = target_command(&request)?;
        command.current_dir(&request.cwd);
        command.env_clear();
        command.envs(&request.env);
        command.stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
        let status = command.status().map_err(|_| "failed to start target process".to_string())?;
        std::process::exit(status.code().unwrap_or(1));
    }
}

#[cfg(target_os = "windows")]
fn execute_windows(request: &ExecutionRequest) -> Result<(), String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, LocalFree};
    use windows_sys::Win32::Security::{SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES};
    use windows_sys::Win32::Security::Isolation::{CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName};
    use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOBOBJECT_BASIC_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, SetInformationJobObject};
    use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};
    use windows_sys::Win32::System::Threading::{CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess, InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, PROCESS_INFORMATION, STARTUPINFOEXW, EXTENDED_STARTUPINFO_PRESENT, STARTF_USESTDHANDLES};

    let profile = widestring("CodingAgentSandbox");
    let display = widestring("Coding Agent Sandbox");
    let description = widestring("Restricted coding agent command sandbox");
    let mut sid: *mut core::ffi::c_void = null_mut();
    let created = unsafe { CreateAppContainerProfile(profile.as_ptr(), display.as_ptr(), description.as_ptr(), null(), 0, &mut sid) };
    if created < 0 {
        let derived = unsafe { DeriveAppContainerSidFromAppContainerName(profile.as_ptr(), &mut sid) };
        if derived < 0 { return Err(format!("failed to create AppContainer profile: HRESULT {created:#x}")); }
    }
    let _workspace_acl = WorkspaceAclGrant::grant(&request.workspace_root, sid)?;

    let mut attr_size = 0usize;
    unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attr_size); }
    let mut attr_storage = vec![0u8; attr_size];
    let attrs = attr_storage.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
    if unsafe { InitializeProcThreadAttributeList(attrs, 1, 0, &mut attr_size) } == 0 { return Err(format!("failed to initialize process attributes: {}", unsafe { GetLastError() })); }
    let security = SECURITY_CAPABILITIES { AppContainerSid: sid, Capabilities: null_mut::<SID_AND_ATTRIBUTES>(), CapabilityCount: 0, Reserved: 0 };
    if unsafe { windows_sys::Win32::System::Threading::UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize, (&security as *const _) as *const _, std::mem::size_of::<SECURITY_CAPABILITIES>(), null_mut(), null()) } == 0 {
        unsafe { DeleteProcThreadAttributeList(attrs); LocalFree(sid); }
        return Err("failed to apply AppContainer security capabilities".to_string());
    }
    let mut command_line = widestring(&format!("\"{}\" {}", request.executable, request.args.iter().map(|arg| format!("\"{}\"", arg.replace('"', "\\\""))).collect::<Vec<_>>().join(" ")));
    let environment = environment_block(&request.env);
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
    startup.StartupInfo.hStdOutput = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    startup.StartupInfo.hStdError = unsafe { GetStdHandle(STD_ERROR_HANDLE) };
    startup.lpAttributeList = attrs;
    let mut info = PROCESS_INFORMATION::default();
    let current_dir = widestring(&request.cwd);
    // 继承 helper 的受控 stdio 管道，便于上层施加输出上限；环境仍由显式 block 提供。
    let created_process = unsafe { CreateProcessW(null(), command_line.as_mut_ptr(), null(), null(), 1, EXTENDED_STARTUPINFO_PRESENT | 0x00000400, environment.as_ptr() as *const _, current_dir.as_ptr(), &startup.StartupInfo, &mut info) };
    unsafe { DeleteProcThreadAttributeList(attrs); LocalFree(sid); }
    if created_process == 0 { return Err(format!("failed to create AppContainer process: {}", unsafe { GetLastError() })); }
    unsafe {
        CloseHandle(info.hThread);
        let job = CreateJobObjectW(null_mut(), null());
        if job.is_null() { return Err("failed to create Windows Job Object".to_string()); }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION { LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, ..std::mem::zeroed() },
            ..std::mem::zeroed()
        };
        let _ = SetInformationJobObject(job, JobObjectExtendedLimitInformation, (&mut limits as *mut _) as *mut _, std::mem::size_of_val(&limits) as u32);
        if AssignProcessToJobObject(job, info.hProcess) == 0 {
            CloseHandle(job);
            return Err("failed to assign target to Windows Job Object".to_string());
        }
        let _ = windows_sys::Win32::System::Threading::WaitForSingleObject(info.hProcess, 0xFFFFFFFF);
        let mut exit_code = 1u32;
        let _ = GetExitCodeProcess(info.hProcess, &mut exit_code);
        CloseHandle(info.hProcess);
        CloseHandle(job);
        std::process::exit(exit_code as i32);
    }
}

#[cfg(target_os = "windows")]
fn widestring(value: &str) -> Vec<u16> { value.encode_utf16().chain(std::iter::once(0)).collect() }

#[cfg(target_os = "windows")]
fn environment_block(env: &std::collections::BTreeMap<String, String>) -> Vec<u16> {
    let mut block = Vec::new();
    for (key, value) in env {
        block.extend(format!("{key}={value}").encode_utf16());
        block.push(0);
    }
    block.push(0);
    block
}

/** 保存原始 DACL 并仅为本次 AppContainer SID 追加可继承访问；Drop 必须恢复原始 DACL。 */
#[cfg(target_os = "windows")]
struct WorkspaceAclGrant { path: Vec<u16>, original: *mut windows_sys::Win32::Security::ACL, descriptor: windows_sys::Win32::Security::PSECURITY_DESCRIPTOR }

#[cfg(target_os = "windows")]
impl WorkspaceAclGrant {
    fn grant(root: &str, sid: *mut core::ffi::c_void) -> Result<Self, String> {
        use windows_sys::Win32::Foundation::{GENERIC_ALL, LocalFree};
        use windows_sys::Win32::Security::{ACL, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, OBJECT_INHERIT_ACE, PSECURITY_DESCRIPTOR};
        use windows_sys::Win32::Security::Authorization::{EXPLICIT_ACCESS_W, GetNamedSecurityInfoW, GRANT_ACCESS, SE_FILE_OBJECT, SetEntriesInAclW, SetNamedSecurityInfoW, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W};
        let path = widestring(root);
        let mut old_acl: *mut ACL = std::ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let get = unsafe { GetNamedSecurityInfoW(path.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, std::ptr::null_mut(), std::ptr::null_mut(), &mut old_acl, std::ptr::null_mut(), &mut descriptor) };
        if get != 0 { return Err(format!("failed to save workspace DACL: {get}")); }
        let mut entry = EXPLICIT_ACCESS_W::default();
        entry.grfAccessPermissions = GENERIC_ALL;
        entry.grfAccessMode = GRANT_ACCESS;
        entry.grfInheritance = CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE;
        entry.Trustee = TRUSTEE_W { pMultipleTrustee: std::ptr::null_mut(), MultipleTrusteeOperation: 0, TrusteeForm: TRUSTEE_IS_SID, TrusteeType: TRUSTEE_IS_UNKNOWN, ptstrName: sid as *mut u16 };
        let mut new_acl: *mut ACL = std::ptr::null_mut();
        let add = unsafe { SetEntriesInAclW(1, &entry, old_acl, &mut new_acl) };
        if add != 0 { unsafe { LocalFree(descriptor as *mut _); } return Err(format!("failed to build workspace DACL: {add}")); }
        let set = unsafe { SetNamedSecurityInfoW(path.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, std::ptr::null_mut(), std::ptr::null_mut(), new_acl, std::ptr::null_mut()) };
        unsafe { LocalFree(new_acl as *mut _); }
        if set != 0 { unsafe { LocalFree(descriptor as *mut _); } return Err(format!("failed to grant workspace access: {set}")); }
        Ok(Self { path, original: old_acl, descriptor })
    }
}

#[cfg(target_os = "windows")]
impl Drop for WorkspaceAclGrant {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;
        use windows_sys::Win32::Security::Authorization::{SE_FILE_OBJECT, SetNamedSecurityInfoW};
        unsafe {
            let _ = SetNamedSecurityInfoW(self.path.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, std::ptr::null_mut(), std::ptr::null_mut(), self.original, std::ptr::null_mut());
            LocalFree(self.descriptor as *mut _);
        }
    }
}

fn validate(request: &ExecutionRequest) -> Result<(), String> {
    if request.executable.is_empty() || request.executable.len() > 4096 || request.executable.contains('\0') {
        return Err("invalid executable".to_string());
    }
    if request.cwd.is_empty() || request.cwd.len() > 4096 || request.cwd.contains('\0') {
        return Err("invalid cwd".to_string());
    }
    if request.network != "off" {
        return Err("network capability is not available".to_string());
    }
    #[cfg(target_os = "windows")]
    if !windows_network_isolation_available() {
        return Err("Windows network isolation is unavailable; refusing to execute".to_string());
    }
    if request.timeout_ms == 0 || request.timeout_ms > 120_000 || request.max_stdout_bytes == 0 || request.max_stderr_bytes == 0 {
        return Err("resource limits are outside helper policy".to_string());
    }
    let root = std::fs::canonicalize(&request.workspace_root).map_err(|_| "workspace root does not exist".to_string())?;
    let cwd = std::fs::canonicalize(&request.cwd).map_err(|_| "cwd does not exist".to_string())?;
    if !cwd.is_dir() {
        return Err("cwd is not a directory".to_string());
    }
    if !cwd.starts_with(&root) {
        return Err("cwd is outside the workspace".to_string());
    }
    if request.args.iter().any(|arg| arg.contains('\0') || arg.len() > 64 * 1024) {
        return Err("invalid argument".to_string());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn target_command(request: &ExecutionRequest) -> Result<Command, String> {
    #[cfg(target_os = "linux")]
    {
        let unshare = find_unshare().ok_or_else(|| "linux namespace helper unavailable".to_string())?;
        let mut command = Command::new(unshare);
        command.args(["--user", "--map-root-user", "--pid", "--fork", "--mount-proc", "--net", "--"]);
        command.arg(&request.executable).args(&request.args);
        return Ok(command);
    }
    #[allow(unreachable_code)]
    Err("unsupported platform".to_string())
}

/** Windows 仅在 AppContainer profile 与 Job Object 都可创建时声明隔离能力。 */
#[cfg(target_os = "windows")]
fn windows_network_isolation_available() -> bool { windows_isolation_probe() }

#[cfg(target_os = "windows")]
fn windows_isolation_probe() -> bool {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Security::Isolation::{CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName};
    use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
    let profile = widestring("CodingAgentSandbox");
    let display = widestring("Coding Agent Sandbox");
    let description = widestring("Restricted coding agent command sandbox");
    let mut sid: *mut core::ffi::c_void = null_mut();
    let hr = unsafe { CreateAppContainerProfile(profile.as_ptr(), display.as_ptr(), description.as_ptr(), null(), 0, &mut sid) };
    let profile_ok = hr >= 0 || unsafe { DeriveAppContainerSidFromAppContainerName(profile.as_ptr(), &mut sid) } >= 0;
    let job = unsafe { CreateJobObjectW(null_mut(), null()) };
    let job_ok = !job.is_null();
    unsafe { if !job.is_null() { CloseHandle(job); } }
    profile_ok && job_ok && !sid.is_null()
}


#[cfg(target_os = "linux")]
fn find_unshare() -> Option<PathBuf> {
    ["/usr/bin/unshare", "/bin/unshare"]
        .iter()
        .map(Path::new)
        .find(|path| path.is_file())
        .map(Path::to_path_buf)
}

#[cfg(target_os = "linux")]
fn namespace_probe() -> bool {
    let Some(unshare) = find_unshare() else { return false };
    Command::new(unshare)
        .args(["--user", "--map-root-user", "--pid", "--fork", "--mount-proc", "--net", "--", "/bin/true"])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}
