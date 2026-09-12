use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::env;
#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};
#[cfg(not(target_os = "windows"))]
use std::process::Command;
#[cfg(not(target_os = "windows"))]
use std::process::Stdio;

const PROTOCOL_VERSION: &str = "1";

#[derive(Debug, Deserialize, Serialize)]
struct ExecutionRequest {
    execution_id: String,
    workspace_root: String,
    executable: String,
    args: Vec<String>,
    cwd: String,
    env: std::collections::BTreeMap<String, String>,
    timeout_ms: u64,
    max_stdout_bytes: u64,
    max_stderr_bytes: u64,
    network: String,
    #[serde(default)]
    cpu_time_ms: u64,
    #[serde(default)]
    memory_bytes: u64,
    #[serde(default)]
    max_processes: u32,
}

fn main() {
    let result = match env::args().nth(1).as_deref() {
        Some("--capabilities") => capabilities(),
        Some("--execute") => execute(env::args().nth(2)),
        #[cfg(target_os = "linux")]
        Some("--linux-launch") => linux_launch(env::args().nth(2)),
        #[cfg(target_os = "linux")]
        Some("--seccomp-probe") => seccomp_probe(),
        _ => Err("invalid helper invocation".to_string()),
    };
    if let Err(error) = result {
        eprintln!("sandbox-helper: {error}");
        std::process::exit(125);
    }
}

fn capabilities() -> Result<(), String> {
    #[allow(unused_mut)]
    let mut values = vec![
        "process.spawn",
        "process-tree",
        "workspace.fs",
        "protocol.v1",
        "resource.limits",
    ];
    #[cfg(target_os = "linux")]
    if linux_hardening_probe() && seccomp_available() {
        values.push("network.off");
        values.push("os.isolation");
        values.push("hardening.no_new_privs");
        values.push("hardening.read_only_root");
        values.push("hardening.credential_paths");
        values.push("hardening.seccomp");
        if cgroup_v2_available() {
            values.push("hardening.cgroup");
        }
    }
    #[cfg(target_os = "windows")]
    if windows_isolation_probe() {
        values.push("network.off");
        values.push("os.isolation");
        values.push("hardening.appcontainer");
        values.push("hardening.handle_whitelist");
        values.push("hardening.restricted_token");
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
    let request = decode_request(encoded)?;
    validate(&request)?;

    #[cfg(target_os = "windows")]
    {
        return execute_windows(&request);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut command = target_command(&request)?;
        command.current_dir(&request.cwd);
        command.env_clear();
        command.envs(&request.env);
        command
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        let mut child = command
            .spawn()
            .map_err(|_| "failed to start target process".to_string())?;
        #[cfg(target_os = "linux")]
        let cgroup = if cgroup_v2_available() {
            match CgroupGuard::attach(&request, child.id()) {
                Ok(guard) => Some(guard),
                Err(error) => {
                    let _ = unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
                    let _ = child.wait();
                    return Err(error);
                }
            }
        } else {
            None
        };
        #[cfg(not(target_os = "linux"))]
        let cgroup: Option<()> = None;
        let deadline =
            std::time::Instant::now() + std::time::Duration::from_millis(request.timeout_ms);
        loop {
            if let Some(status) = child
                .try_wait()
                .map_err(|_| "failed to wait for target process".to_string())?
            {
                drop(cgroup);
                std::process::exit(status.code().unwrap_or(1));
            }
            if std::time::Instant::now() >= deadline {
                // Helper 自己的超时路径也必须清理完整进程组，不能只结束直接子进程。
                let _ = unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
                let _ = child.wait();
                drop(cgroup);
                return Err("execution timed out".to_string());
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
}

fn decode_request(encoded: Option<String>) -> Result<ExecutionRequest, String> {
    let encoded = encoded.ok_or_else(|| "missing encoded request".to_string())?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "invalid request encoding".to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| "invalid request JSON".to_string())
}

#[cfg(target_os = "windows")]
fn execute_windows(request: &ExecutionRequest) -> Result<(), String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, LocalFree};
    use windows_sys::Win32::Security::Isolation::{
        CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
    };
    use windows_sys::Win32::Security::{
        CreateRestrictedToken, DISABLE_MAX_PRIVILEGE, SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES,
        TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Console::{
        GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_LIMIT_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessAsUserW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess,
        InitializeProcThreadAttributeList, OpenProcessToken, ResumeThread, TerminateProcess,
        EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
        PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    };

    // 每次执行使用独立 AppContainer 身份，避免不同 Agent run 共享权限与残留状态。
    let profile_name = format!(
        "CodingAgentSandbox-{}",
        sanitize_profile_id(&request.execution_id)
    );
    let profile = widestring(&profile_name);
    let display = widestring("Coding Agent Sandbox");
    let description = widestring("Restricted coding agent command sandbox");
    let mut sid: *mut core::ffi::c_void = null_mut();
    let created = unsafe {
        CreateAppContainerProfile(
            profile.as_ptr(),
            display.as_ptr(),
            description.as_ptr(),
            null(),
            0,
            &mut sid,
        )
    };
    if created < 0 {
        let derived =
            unsafe { DeriveAppContainerSidFromAppContainerName(profile.as_ptr(), &mut sid) };
        if derived < 0 {
            return Err(format!(
                "failed to create AppContainer profile: HRESULT {created:#x}"
            ));
        }
    }
    let workspace_acl = WorkspaceAclGrant::grant(&request.workspace_root, sid)?;
    // 先建立并配置 Job，再以挂起状态创建目标。这样目标没有机会在被纳入 Job 前派生逃逸子进程。
    let job = unsafe { CreateJobObjectW(null_mut(), null()) };
    if job.is_null() {
        return Err("failed to create Windows Job Object".to_string());
    }
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION {
            LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | 0x00000002 | 0x00000008 | 0x00000100,
            ActiveProcessLimit: request.max_processes,
            PerProcessUserTimeLimit: request.cpu_time_ms.saturating_mul(10_000) as i64,
            ..unsafe { std::mem::zeroed() }
        },
        ProcessMemoryLimit: request.memory_bytes as usize,
        ..unsafe { std::mem::zeroed() }
    };
    if unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&mut limits as *mut _) as *mut _,
            std::mem::size_of_val(&limits) as u32,
        )
    } == 0
    {
        unsafe { CloseHandle(job) };
        return Err("failed to configure Windows Job Object limits".to_string());
    }
    let mut source_token = null_mut();
    let mut restricted_token = null_mut();
    if unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY,
            &mut source_token,
        )
    } == 0
        || unsafe {
            CreateRestrictedToken(
                source_token,
                DISABLE_MAX_PRIVILEGE,
                0,
                null(),
                0,
                null(),
                0,
                null(),
                &mut restricted_token,
            )
        } == 0
    {
        unsafe {
            if !source_token.is_null() {
                CloseHandle(source_token);
            }
            LocalFree(sid);
        }
        return Err("failed to create restricted Windows sandbox token".to_string());
    }
    unsafe {
        CloseHandle(source_token);
    }

    let mut attr_size = 0usize;
    unsafe {
        InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut attr_size);
    }
    let mut attr_storage = vec![0u8; attr_size];
    let attrs = attr_storage.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
    if unsafe { InitializeProcThreadAttributeList(attrs, 2, 0, &mut attr_size) } == 0 {
        return Err(format!(
            "failed to initialize process attributes: {}",
            unsafe { GetLastError() }
        ));
    }
    let security = SECURITY_CAPABILITIES {
        AppContainerSid: sid,
        Capabilities: null_mut::<SID_AND_ATTRIBUTES>(),
        CapabilityCount: 0,
        Reserved: 0,
    };
    if unsafe {
        windows_sys::Win32::System::Threading::UpdateProcThreadAttribute(
            attrs,
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            (&security as *const _) as *const _,
            std::mem::size_of::<SECURITY_CAPABILITIES>(),
            null_mut(),
            null(),
        )
    } == 0
    {
        unsafe {
            DeleteProcThreadAttributeList(attrs);
            CloseHandle(restricted_token);
            LocalFree(sid);
        }
        return Err("failed to apply AppContainer security capabilities".to_string());
    }
    let inherited_handles = [
        unsafe { GetStdHandle(STD_INPUT_HANDLE) },
        unsafe { GetStdHandle(STD_OUTPUT_HANDLE) },
        unsafe { GetStdHandle(STD_ERROR_HANDLE) },
    ];
    // 仅白名单标准流，阻断 Agent/Helper 其他可继承句柄进入不可信目标。
    if inherited_handles.iter().any(|handle| handle.is_null())
        || unsafe {
            windows_sys::Win32::System::Threading::UpdateProcThreadAttribute(
                attrs,
                0,
                0x0002_0002,
                inherited_handles.as_ptr() as *const _,
                std::mem::size_of_val(&inherited_handles),
                null_mut(),
                null(),
            )
        } == 0
    {
        unsafe {
            DeleteProcThreadAttributeList(attrs);
            CloseHandle(restricted_token);
            LocalFree(sid);
        }
        return Err("failed to restrict inherited process handles".to_string());
    }
    let mut command_line = widestring(&format!(
        "\"{}\" {}",
        request.executable,
        request
            .args
            .iter()
            .map(|arg| format!("\"{}\"", arg.replace('"', "\\\"")))
            .collect::<Vec<_>>()
            .join(" ")
    ));
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
    let created_process = unsafe {
        CreateProcessAsUserW(
            restricted_token,
            null(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT | 0x00000400 | 0x00000004,
            environment.as_ptr() as *const _,
            current_dir.as_ptr(),
            &startup.StartupInfo,
            &mut info,
        )
    };
    unsafe {
        DeleteProcThreadAttributeList(attrs);
        CloseHandle(restricted_token);
        LocalFree(sid);
    }
    if created_process == 0 {
        unsafe { CloseHandle(job) };
        return Err(format!(
            "failed to create AppContainer process: {}",
            unsafe { GetLastError() }
        ));
    }
    unsafe {
        if AssignProcessToJobObject(job, info.hProcess) == 0 {
            // 目标仍处于挂起状态，加入 Job 失败时绝不能恢复它。
            let _ = TerminateProcess(info.hProcess, 125);
            CloseHandle(info.hThread);
            CloseHandle(info.hProcess);
            CloseHandle(job);
            return Err("failed to assign target to Windows Job Object".to_string());
        }
        if ResumeThread(info.hThread) == u32::MAX {
            let _ = TerminateJobObject(job, 125);
            CloseHandle(info.hThread);
            CloseHandle(info.hProcess);
            CloseHandle(job);
            return Err("failed to resume AppContainer process".to_string());
        }
        CloseHandle(info.hThread);
        let wait = windows_sys::Win32::System::Threading::WaitForSingleObject(
            info.hProcess,
            request.timeout_ms.min(u32::MAX as u64) as u32,
        );
        if wait == 0x00000102 {
            // 超时直接终止 Job，确保目标及其子孙进程一起结束。
            let _ = TerminateJobObject(job, 124);
            let _ =
                windows_sys::Win32::System::Threading::WaitForSingleObject(info.hProcess, 5_000);
        }
        let mut exit_code = 1u32;
        let _ = GetExitCodeProcess(info.hProcess, &mut exit_code);
        CloseHandle(info.hProcess);
        CloseHandle(job);
        // std::process::exit 不会执行 Drop；必须先同步恢复所有 workspace DACL。
        drop(workspace_acl);
        // 进程和临时 ACL 均已清理后再删除 profile；删除失败不影响已结束的执行结果。
        let _ =
            windows_sys::Win32::Security::Isolation::DeleteAppContainerProfile(profile.as_ptr());
        std::process::exit(exit_code as i32);
    }
}

#[cfg(target_os = "windows")]
fn widestring(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

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

#[cfg(target_os = "windows")]
fn sanitize_profile_id(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(64)
        .collect::<String>()
}

/** 保存原始 DACL 并仅为本次 AppContainer SID 追加可继承访问；Drop 必须恢复原始 DACL。 */
#[cfg(target_os = "windows")]
struct WorkspaceAclGrant {
    entries: Vec<WorkspaceAclEntry>,
}

/** 每个已存在 workspace 项都保存原始 DACL，且绝不跟随 reparse point。 */
#[cfg(target_os = "windows")]
struct WorkspaceAclEntry {
    path: Vec<u16>,
    original: *mut windows_sys::Win32::Security::ACL,
    descriptor: windows_sys::Win32::Security::PSECURITY_DESCRIPTOR,
}

#[cfg(target_os = "windows")]
impl WorkspaceAclGrant {
    fn grant(root: &str, sid: *mut core::ffi::c_void) -> Result<Self, String> {
        let mut paths = vec![std::path::PathBuf::from(root)];
        collect_workspace_acl_paths(std::path::Path::new(root), &mut paths)?;
        let mut entries = Vec::with_capacity(paths.len());
        for path in paths {
            match WorkspaceAclEntry::grant(&path, sid) {
                Ok(entry) => entries.push(entry),
                Err(error) => {
                    // 部分授权也必须立即回滚，避免 Helper 失败后扩大 AppContainer 权限。
                    drop(WorkspaceAclGrant { entries });
                    return Err(error);
                }
            }
        }
        Ok(Self { entries })
    }
}

#[cfg(target_os = "windows")]
impl WorkspaceAclEntry {
    fn grant(root: &std::path::Path, sid: *mut core::ffi::c_void) -> Result<Self, String> {
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
        };
        Self::grant_with_permissions(
            root,
            sid,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE,
        )
    }

    fn grant_with_permissions(
        root: &std::path::Path,
        sid: *mut core::ffi::c_void,
        permissions: u32,
    ) -> Result<Self, String> {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::{
            GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W,
            GRANT_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
        };
        use windows_sys::Win32::Security::{
            ACL, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, OBJECT_INHERIT_ACE,
            PSECURITY_DESCRIPTOR,
        };
        let path = widestring(&root.to_string_lossy());
        let mut old_acl: *mut ACL = std::ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let get = unsafe {
            GetNamedSecurityInfoW(
                path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut old_acl,
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        if get != 0 {
            return Err(format!("failed to save workspace DACL: {get}"));
        }
        let mut entry = EXPLICIT_ACCESS_W::default();
        // 不使用 GENERIC_ALL，调用方只能申请完成其功能所需的最小文件权限。
        entry.grfAccessPermissions = permissions;
        entry.grfAccessMode = GRANT_ACCESS;
        entry.grfInheritance = CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE;
        entry.Trustee = TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: 0,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: sid as *mut u16,
        };
        let mut new_acl: *mut ACL = std::ptr::null_mut();
        let add = unsafe { SetEntriesInAclW(1, &entry, old_acl, &mut new_acl) };
        if add != 0 {
            unsafe {
                LocalFree(descriptor as *mut _);
            }
            return Err(format!("failed to build workspace DACL: {add}"));
        }
        let set = unsafe {
            SetNamedSecurityInfoW(
                path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                new_acl,
                std::ptr::null_mut(),
            )
        };
        unsafe {
            LocalFree(new_acl as *mut _);
        }
        if set != 0 {
            unsafe {
                LocalFree(descriptor as *mut _);
            }
            return Err(format!(
                "failed to grant workspace access for {}: {set}",
                root.display()
            ));
        }
        Ok(Self {
            path,
            original: old_acl,
            descriptor,
        })
    }
}

#[cfg(target_os = "windows")]
impl Drop for WorkspaceAclEntry {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::{SetNamedSecurityInfoW, SE_FILE_OBJECT};
        use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;
        unsafe {
            let _ = SetNamedSecurityInfoW(
                self.path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                self.original,
                std::ptr::null_mut(),
            );
            LocalFree(self.descriptor as *mut _);
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for WorkspaceAclGrant {
    fn drop(&mut self) {
        // 逆序恢复目录项，确保出错路径也撤销所有临时授权。
        self.entries.reverse();
    }
}

/** 只为普通文件和目录授权；junction/symlink/reparse point 一律不跟随。 */
#[cfg(target_os = "windows")]
fn collect_workspace_acl_paths(
    root: &std::path::Path,
    paths: &mut Vec<std::path::PathBuf>,
) -> Result<(), String> {
    for entry in std::fs::read_dir(root)
        .map_err(|_| "failed to enumerate workspace ACL entries".to_string())?
    {
        let entry = entry.map_err(|_| "failed to enumerate workspace ACL entries".to_string())?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|_| "failed to inspect workspace ACL entry".to_string())?;
        use std::os::windows::fs::MetadataExt;
        if metadata.file_type().is_symlink() || metadata.file_attributes() & 0x0000_0400 != 0 {
            // reparse point 可能指向 workspace 外，绝不能把临时 AppContainer ACL 授予其目标。
            continue;
        }
        paths.push(path.clone());
        if metadata.is_dir() {
            collect_workspace_acl_paths(&path, paths)?;
        }
    }
    Ok(())
}

fn validate(request: &ExecutionRequest) -> Result<(), String> {
    if request.executable.is_empty()
        || request.executable.len() > 4096
        || request.executable.contains('\0')
    {
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
    if request.execution_id.is_empty()
        || request.execution_id.len() > 128
        || request.timeout_ms == 0
        || request.timeout_ms > 120_000
        || request.max_stdout_bytes == 0
        || request.max_stderr_bytes == 0
        || request.cpu_time_ms == 0
        || request.memory_bytes == 0
        || request.max_processes == 0
    {
        return Err("resource limits are outside helper policy".to_string());
    }
    let root = std::fs::canonicalize(&request.workspace_root)
        .map_err(|_| "workspace root does not exist".to_string())?;
    let cwd = std::fs::canonicalize(&request.cwd).map_err(|_| "cwd does not exist".to_string())?;
    if !cwd.is_dir() {
        return Err("cwd is not a directory".to_string());
    }
    if !cwd.starts_with(&root) {
        return Err("cwd is outside the workspace".to_string());
    }
    if request
        .args
        .iter()
        .any(|arg| arg.contains('\0') || arg.len() > 64 * 1024)
    {
        return Err("invalid argument".to_string());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn target_command(request: &ExecutionRequest) -> Result<Command, String> {
    #[cfg(target_os = "linux")]
    {
        let unshare =
            find_unshare().ok_or_else(|| "linux namespace helper unavailable".to_string())?;
        let helper =
            env::current_exe().map_err(|_| "unable to locate sandbox helper".to_string())?;
        let encoded = STANDARD.encode(
            serde_json::to_vec(request)
                .map_err(|_| "unable to encode sandbox request".to_string())?,
        );
        let mut command = Command::new(unshare);
        command.args([
            "--user",
            "--map-root-user",
            "--mount",
            "--pid",
            "--fork",
            "--mount-proc",
            "--net",
            "--",
            "/bin/sh",
            "-ceu",
            LINUX_SANDBOX_SCRIPT,
            "sandbox-launcher",
            &request.workspace_root,
            &request.cwd,
        ]);
        command.arg(helper).arg(encoded);
        use std::os::unix::process::CommandExt;
        command.pre_exec(move || {
            // 外层进程组让 Helper 即使异常也能一次清理完整目标树。
            if unsafe { libc::setpgid(0, 0) } != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
        return Ok(command);
    }
    #[allow(unreachable_code)]
    Err("unsupported platform".to_string())
}

/** Windows 仅在 AppContainer profile 与 Job Object 都可创建时声明隔离能力。 */
#[cfg(target_os = "windows")]
fn windows_network_isolation_available() -> bool {
    windows_isolation_probe()
}

#[cfg(target_os = "windows")]
fn windows_isolation_probe() -> bool {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Security::Isolation::{
        CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
    };
    use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
    let profile = widestring("CodingAgentSandbox");
    let display = widestring("Coding Agent Sandbox");
    let description = widestring("Restricted coding agent command sandbox");
    let mut sid: *mut core::ffi::c_void = null_mut();
    let hr = unsafe {
        CreateAppContainerProfile(
            profile.as_ptr(),
            display.as_ptr(),
            description.as_ptr(),
            null(),
            0,
            &mut sid,
        )
    };
    let profile_ok = hr >= 0
        || unsafe { DeriveAppContainerSidFromAppContainerName(profile.as_ptr(), &mut sid) } >= 0;
    let job = unsafe { CreateJobObjectW(null_mut(), null()) };
    let job_ok = !job.is_null();
    unsafe {
        if !job.is_null() {
            CloseHandle(job);
        }
    }
    profile_ok && job_ok && !sid.is_null() && windows_restricted_token_probe()
}

#[cfg(target_os = "windows")]
fn windows_restricted_token_probe() -> bool {
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Security::{
        CreateRestrictedToken, DISABLE_MAX_PRIVILEGE, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE,
        TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    let mut source = null_mut();
    let mut restricted = null_mut();
    let opened = unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY,
            &mut source,
        )
    } != 0;
    let created = opened
        && unsafe {
            CreateRestrictedToken(
                source,
                DISABLE_MAX_PRIVILEGE,
                0,
                null_mut(),
                0,
                null_mut(),
                0,
                null_mut(),
                &mut restricted,
            )
        } != 0;
    unsafe {
        if !source.is_null() {
            CloseHandle(source);
        }
        if !restricted.is_null() {
            CloseHandle(restricted);
        }
    }
    created
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
    let Some(unshare) = find_unshare() else {
        return false;
    };
    Command::new(unshare)
        .args([
            "--user",
            "--map-root-user",
            "--pid",
            "--fork",
            "--mount-proc",
            "--net",
            "--",
            "/bin/true",
        ])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/**
 * 目标进程必须位于独立 mount namespace：宿主根只读，workspace 单独 bind 回可写，
 * 并用空 tmpfs 覆盖常见凭据目录。探测失败时不宣称 OS isolation，调用方随即 Fail Closed。
 */
#[cfg(target_os = "linux")]
const LINUX_SANDBOX_SCRIPT: &str = r#"
workspace="$1"
cwd="$2"
helper="$3"
encoded="$4"
mount --make-rprivate /
mount -o remount,ro /
mount --bind "$workspace" "$workspace"
mount -o remount,rw,bind "$workspace"
for secret_dir in /home /root /run/user; do
  if [ -d "$secret_dir" ]; then
    mount -t tmpfs -o mode=755,nosuid,nodev,noexec tmpfs "$secret_dir"
  fi
done
cd "$cwd"
exec "$helper" --linux-launch "$encoded"
"#;

#[cfg(target_os = "linux")]
fn linux_hardening_probe() -> bool {
    let Some(unshare) = find_unshare() else {
        return false;
    };
    Command::new(unshare)
        .args([
            "--user",
            "--map-root-user",
            "--mount",
            "--pid",
            "--fork",
            "--net",
            "--mount-proc",
            "--",
            "/bin/sh",
            "-ceu",
            LINUX_SANDBOX_SCRIPT,
            "sandbox-probe",
            "/tmp",
            "/tmp",
            "/bin/true",
        ])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn linux_launch(encoded: Option<String>) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let request = decode_request(encoded)?;
    validate(&request)?;
    let memory = libc::rlimit {
        rlim_cur: request.memory_bytes as libc::rlim_t,
        rlim_max: request.memory_bytes as libc::rlim_t,
    };
    let processes = libc::rlimit {
        rlim_cur: request.max_processes as libc::rlim_t,
        rlim_max: request.max_processes as libc::rlim_t,
    };
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0
        || unsafe { libc::setrlimit(libc::RLIMIT_AS, &memory) } != 0
        || unsafe { libc::setrlimit(libc::RLIMIT_NPROC, &processes) } != 0
    {
        return Err("failed to apply Linux resource hardening".to_string());
    }
    install_seccomp_filter()?;
    let mut command = Command::new(&request.executable);
    command
        .args(&request.args)
        .current_dir(&request.cwd)
        .env_clear()
        .envs(&request.env);
    Err(command.exec().to_string())
}

#[cfg(target_os = "linux")]
fn seccomp_probe() -> Result<(), String> {
    install_seccomp_filter()
}

#[cfg(target_os = "linux")]
fn seccomp_available() -> bool {
    let Ok(helper) = env::current_exe() else {
        return false;
    };
    Command::new(helper)
        .arg("--seccomp-probe")
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/** 默认允许常规构建 syscall，但拒绝命名空间、挂载、内核与调试攻击面。 */
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn install_seccomp_filter() -> Result<(), String> {
    use libc::{sock_filter, sock_fprog};
    const RET_ERRNO: u32 = 0x0005_0001;
    const RET_ALLOW: u32 = 0x7fff_0000;
    const RET_KILL: u32 = 0x8000_0000;
    const ARCH_X86_64: u32 = 0xc000_003e;
    let denied = [
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_pivot_root,
        libc::SYS_unshare,
        libc::SYS_setns,
        libc::SYS_ptrace,
        libc::SYS_bpf,
        libc::SYS_keyctl,
        libc::SYS_add_key,
        libc::SYS_request_key,
        libc::SYS_reboot,
        libc::SYS_init_module,
        libc::SYS_finit_module,
        libc::SYS_delete_module,
        libc::SYS_open_by_handle_at,
        libc::SYS_kexec_load,
    ];
    let mut filter = vec![
        unsafe { libc::BPF_STMT(libc::BPF_LD | libc::BPF_W | libc::BPF_ABS, 4) },
        unsafe {
            libc::BPF_JUMP(
                libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K,
                ARCH_X86_64,
                1,
                0,
            )
        },
        unsafe { libc::BPF_STMT(libc::BPF_RET | libc::BPF_K, RET_KILL) },
        unsafe { libc::BPF_STMT(libc::BPF_LD | libc::BPF_W | libc::BPF_ABS, 0) },
        unsafe {
            libc::BPF_JUMP(
                libc::BPF_JMP | libc::BPF_JSET | libc::BPF_K,
                0x4000_0000,
                0,
                1,
            )
        },
        unsafe { libc::BPF_STMT(libc::BPF_RET | libc::BPF_K, RET_ERRNO) },
    ];
    for syscall in denied {
        filter.push(unsafe {
            libc::BPF_JUMP(
                libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K,
                syscall as u32,
                0,
                1,
            )
        });
        filter.push(unsafe { libc::BPF_STMT(libc::BPF_RET | libc::BPF_K, RET_ERRNO) });
    }
    filter.push(unsafe { libc::BPF_STMT(libc::BPF_RET | libc::BPF_K, RET_ALLOW) });
    let mut program = sock_fprog {
        len: filter.len() as u16,
        filter: filter.as_mut_ptr(),
    };
    if unsafe {
        libc::prctl(
            libc::PR_SET_SECCOMP,
            libc::SECCOMP_MODE_FILTER,
            &mut program,
        )
    } != 0
    {
        return Err("failed to install seccomp filter".to_string());
    }
    Ok(())
}

#[cfg(all(target_os = "linux", not(target_arch = "x86_64")))]
fn install_seccomp_filter() -> Result<(), String> {
    Err("seccomp filter is unsupported on this architecture".to_string())
}

/** 仅在 cgroup v2 已由宿主委派为可写时声明能力，避免把权限不足当作“已隔离”。 */
#[cfg(target_os = "linux")]
fn cgroup_v2_available() -> bool {
    let base = std::path::Path::new("/sys/fs/cgroup");
    if !base.join("cgroup.controllers").is_file() {
        return false;
    }
    let probe = base.join(format!("coding-agent-probe-{}", std::process::id()));
    std::fs::create_dir(&probe).is_ok_and(|_| std::fs::remove_dir(&probe).is_ok())
}

/** cgroup 归属于外层 unshare 进程，PID/memory/CPU 限制会继承给其完整子树。 */
#[cfg(target_os = "linux")]
struct CgroupGuard {
    path: std::path::PathBuf,
}

#[cfg(target_os = "linux")]
impl CgroupGuard {
    fn attach(request: &ExecutionRequest, pid: u32) -> Result<Self, String> {
        let path = std::path::Path::new("/sys/fs/cgroup")
            .join(format!("coding-agent-{}", request.execution_id));
        std::fs::create_dir(&path).map_err(|_| "failed to create sandbox cgroup".to_string())?;
        let result = (|| {
            std::fs::write(path.join("memory.max"), request.memory_bytes.to_string())
                .map_err(|_| "failed to set sandbox memory limit".to_string())?;
            std::fs::write(path.join("pids.max"), request.max_processes.to_string())
                .map_err(|_| "failed to set sandbox process limit".to_string())?;
            // 限制到单核；wall-clock 与 CPU 总时间仍分别由 Helper/Job 限制追踪。
            std::fs::write(path.join("cpu.max"), "100000 100000")
                .map_err(|_| "failed to set sandbox CPU limit".to_string())?;
            std::fs::write(path.join("cgroup.procs"), pid.to_string())
                .map_err(|_| "failed to attach sandbox process to cgroup".to_string())?;
            Ok(())
        })();
        if let Err(error) = result {
            let _ = std::fs::remove_dir(&path);
            return Err(error);
        }
        Ok(Self { path })
    }
}

#[cfg(target_os = "linux")]
impl Drop for CgroupGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.path);
    }
}
