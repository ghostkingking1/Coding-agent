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
#[serde(tag = "mode", rename_all = "lowercase")]
enum NetworkPolicy {
    Off,
    Loopback { ports: Vec<u16> },
    Allowlist {
        hosts: Vec<String>,
        ports: Vec<u16>,
        #[serde(rename = "proxyId")]
        proxy_id: String,
        #[serde(rename = "proxyHost")]
        proxy_host: String,
        #[serde(rename = "proxyPort")]
        proxy_port: u16,
    },
}

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
    network: NetworkPolicy,
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
        "filesystem.workspace_write",
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
        values.push("hardening.explicit_environment");
        values.push("hardening.job_object");
        values.push("hardening.acl_recovery_journal");
        if windows_network_isolation_available() {
            values.push("network.loopback");
            values.push("network.proxy");
            values.push("network.allowlist");
        }
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
        CreateRestrictedToken, CreateWellKnownSid, DISABLE_MAX_PRIVILEGE, SECURITY_CAPABILITIES,
        SECURITY_MAX_SID_SIZE, SID_AND_ATTRIBUTES, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE,
        TOKEN_QUERY, WinCapabilityInternetClientSid,
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

    // Helper 启动前先处理上一次异常退出留下的 ACL journal；无法证明当前 ACL
    // 仍是本 Helper 写入的版本时直接拒绝，避免把用户后续权限修改覆盖掉。
    recover_acl_journals()?;
    recover_loopback_journals()?;

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
    let workspace_acl = WorkspaceAclGrant::grant(&request.workspace_root, sid, &request.execution_id)?;
    // 联网 capability 只负责让 AppContainer 网络栈可用；真正的目标约束由同一 SID
    // 上的 WFP 动态过滤器承担。任一守卫安装失败都发生在目标创建/恢复之前。
    let mut internet_capability_sid = vec![0u8; SECURITY_MAX_SID_SIZE as usize];
    let mut internet_capability_size = internet_capability_sid.len() as u32;
    let network_requested = !matches!(request.network, NetworkPolicy::Off);
    if network_requested
        && unsafe {
            CreateWellKnownSid(
                WinCapabilityInternetClientSid,
                null_mut(),
                internet_capability_sid.as_mut_ptr() as *mut _,
                &mut internet_capability_size,
            )
        } == 0
    {
        return Err("failed to create AppContainer internet capability SID".to_string());
    }
    let mut capability = SID_AND_ATTRIBUTES {
        Sid: if network_requested {
            internet_capability_sid.as_mut_ptr() as *mut _
        } else {
            null_mut()
        },
        Attributes: 0,
    };
    let loopback_guard = if network_requested {
        Some(AppContainerLoopbackGuard::install(sid, &request.execution_id)?)
    } else {
        None
    };
    let network_guard = if network_requested {
        Some(WindowsNetworkGuard::install(sid, &request.network)?)
    } else {
        None
    };
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
        Capabilities: if network_requested {
            &mut capability
        } else {
            null_mut::<SID_AND_ATTRIBUTES>()
        },
        CapabilityCount: u32::from(network_requested),
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
        // std::process::exit 不运行析构；先关闭 WFP 动态会话并撤销回环 exemption。
        drop(network_guard);
        drop(loopback_guard);
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
    journal_path: std::path::PathBuf,
}

/**
 * AppContainer 的宿主回环访问由系统级 exemption 列表控制。这里只追加本次 SID，
 * Drop 时重新读取并仅移除自己追加的项，避免覆盖执行期间其他进程的合法修改。
 */
#[cfg(target_os = "windows")]
struct AppContainerLoopbackGuard {
    sid: Vec<u8>,
    added: bool,
    journal_path: Option<std::path::PathBuf>,
}

#[cfg(target_os = "windows")]
impl AppContainerLoopbackGuard {
    fn install(
        sid: windows_sys::Win32::Security::PSID,
        execution_id: &str,
    ) -> Result<Self, String> {
        let sid = copy_windows_sid(sid)?;
        let current = read_loopback_exemptions()?;
        if current.iter().any(|entry| windows_sid_eq(entry, &sid)) {
            return Ok(Self { sid, added: false, journal_path: None });
        }
        let mut updated = current;
        updated.push(sid.clone());
        let journal_path = write_loopback_journal(execution_id, &sid)?;
        if let Err(error) = write_loopback_exemptions(&mut updated) {
            let _ = std::fs::remove_file(&journal_path);
            return Err(error);
        }
        Ok(Self { sid, added: true, journal_path: Some(journal_path) })
    }
}

#[cfg(target_os = "windows")]
impl Drop for AppContainerLoopbackGuard {
    fn drop(&mut self) {
        if !self.added {
            return;
        }
        if let Ok(mut current) = read_loopback_exemptions() {
            current.retain(|entry| !windows_sid_eq(entry, &self.sid));
            if write_loopback_exemptions(&mut current).is_ok() {
                if let Some(path) = &self.journal_path {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
    }
}

#[cfg(target_os = "windows")]
#[derive(Debug, Deserialize, Serialize)]
struct LoopbackJournal {
    sid: String,
}

#[cfg(target_os = "windows")]
fn loopback_journal_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("coding-agent-sandbox-loopback-journal")
}

#[cfg(target_os = "windows")]
fn write_loopback_journal(
    execution_id: &str,
    sid: &[u8],
) -> Result<std::path::PathBuf, String> {
    use std::hash::{Hash, Hasher};
    use std::io::Write;
    let directory = loopback_journal_dir();
    std::fs::create_dir_all(&directory)
        .map_err(|_| "failed to create loopback recovery journal directory".to_string())?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    execution_id.hash(&mut hasher);
    sid.hash(&mut hasher);
    let target = directory.join(format!("loopback-{:016x}.json", hasher.finish()));
    let temporary = target.with_extension("tmp");
    let bytes = serde_json::to_vec(&LoopbackJournal { sid: STANDARD.encode(sid) })
        .map_err(|_| "failed to encode loopback recovery journal".to_string())?;
    let mut file = std::fs::File::create(&temporary)
        .map_err(|_| "failed to write loopback recovery journal".to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "failed to flush loopback recovery journal".to_string())?;
    std::fs::rename(&temporary, &target)
        .map_err(|_| "failed to commit loopback recovery journal".to_string())?;
    Ok(target)
}

#[cfg(target_os = "windows")]
fn recover_loopback_journals() -> Result<(), String> {
    let directory = loopback_journal_dir();
    let items = match std::fs::read_dir(&directory) {
        Ok(items) => items,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("cannot inspect loopback recovery journal".to_string()),
    };
    for item in items {
        let item = item.map_err(|_| "cannot inspect loopback recovery journal".to_string())?;
        if item.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let journal: LoopbackJournal = serde_json::from_slice(
            &std::fs::read(item.path())
                .map_err(|_| "cannot read loopback recovery journal".to_string())?,
        )
        .map_err(|_| "invalid loopback recovery journal; refusing to execute".to_string())?;
        let sid = STANDARD
            .decode(journal.sid)
            .map_err(|_| "invalid SID in loopback recovery journal".to_string())?;
        let mut current = read_loopback_exemptions()?;
        current.retain(|entry| !windows_sid_eq(entry, &sid));
        write_loopback_exemptions(&mut current)?;
        std::fs::remove_file(item.path())
            .map_err(|_| "failed to remove recovered loopback journal".to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn copy_windows_sid(sid: windows_sys::Win32::Security::PSID) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Security::{CopySid, GetLengthSid};
    let length = unsafe { GetLengthSid(sid) };
    if length == 0 {
        return Err("invalid AppContainer SID".to_string());
    }
    let mut copy = vec![0u8; length as usize];
    if unsafe { CopySid(length, copy.as_mut_ptr() as *mut _, sid) } == 0 {
        return Err("failed to copy AppContainer SID".to_string());
    }
    Ok(copy)
}

#[cfg(target_os = "windows")]
fn windows_sid_eq(left: &[u8], right: &[u8]) -> bool {
    use windows_sys::Win32::Security::EqualSid;
    unsafe {
        EqualSid(
            left.as_ptr() as *mut _,
            right.as_ptr() as *mut _,
        ) != 0
    }
}

#[cfg(target_os = "windows")]
fn read_loopback_exemptions() -> Result<Vec<Vec<u8>>, String> {
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::NetworkManagement::WindowsFirewall::NetworkIsolationGetAppContainerConfig;
    use windows_sys::Win32::Security::SID_AND_ATTRIBUTES;
    let mut count = 0u32;
    let mut entries: *mut SID_AND_ATTRIBUTES = null_mut();
    let status = unsafe { NetworkIsolationGetAppContainerConfig(&mut count, &mut entries) };
    if status != 0 {
        return Err(format!("failed to read AppContainer loopback config: {status}"));
    }
    let result = if count == 0 || entries.is_null() {
        Vec::new()
    } else {
        let slice = unsafe { std::slice::from_raw_parts(entries, count as usize) };
        let mut result = Vec::with_capacity(slice.len());
        for entry in slice {
            result.push(copy_windows_sid(entry.Sid)?);
        }
        result
    };
    if !entries.is_null() {
        unsafe { LocalFree(entries as *mut _) };
    }
    Ok(result)
}

#[cfg(target_os = "windows")]
fn write_loopback_exemptions(entries: &mut [Vec<u8>]) -> Result<(), String> {
    use windows_sys::Win32::NetworkManagement::WindowsFirewall::NetworkIsolationSetAppContainerConfig;
    use windows_sys::Win32::Security::SID_AND_ATTRIBUTES;
    let native = entries
        .iter_mut()
        .map(|sid| SID_AND_ATTRIBUTES {
            Sid: sid.as_mut_ptr() as *mut _,
            Attributes: 0,
        })
        .collect::<Vec<_>>();
    let status = unsafe {
        NetworkIsolationSetAppContainerConfig(
            native.len() as u32,
            if native.is_empty() {
                std::ptr::null()
            } else {
                native.as_ptr()
            },
        )
    };
    if status != 0 {
        return Err(format!("failed to update AppContainer loopback config: {status}"));
    }
    Ok(())
}

/** WFP 动态会话关闭时由 BFE 原子删除全部过滤器，Helper 崩溃也不会遗留规则。 */
#[cfg(target_os = "windows")]
struct WindowsNetworkGuard {
    engine: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(target_os = "windows")]
impl WindowsNetworkGuard {
    fn install(
        appcontainer_sid: windows_sys::Win32::Security::PSID,
        policy: &NetworkPolicy,
    ) -> Result<Self, String> {
        use std::ptr::{null, null_mut};
        use windows_sys::Win32::NetworkManagement::WindowsFilteringPlatform::{
            FwpmEngineOpen0, FwpmSubLayerAdd0, FwpmTransactionAbort0,
            FwpmTransactionBegin0, FwpmTransactionCommit0, FWPM_SESSION0,
            FWPM_SESSION_FLAG_DYNAMIC, FWPM_SUBLAYER0,
        };
        use windows_sys::Win32::System::Rpc::{UuidCreate, RPC_C_AUTHN_WINNT};
        let mut session = FWPM_SESSION0::default();
        session.flags = FWPM_SESSION_FLAG_DYNAMIC;
        let mut engine = null_mut();
        let status = unsafe {
            FwpmEngineOpen0(null(), RPC_C_AUTHN_WINNT, null(), &session, &mut engine)
        };
        if status != 0 || engine.is_null() {
            return Err(format!("failed to open dynamic WFP session: {status}"));
        }
        let guard = Self { engine };
        let begin = unsafe { FwpmTransactionBegin0(engine, 0) };
        if begin != 0 {
            return Err(format!("failed to begin WFP transaction: {begin}"));
        }
        let mut sublayer_key = windows_sys::core::GUID::from_u128(0);
        let uuid_status = unsafe { UuidCreate(&mut sublayer_key) };
        if uuid_status != 0 && uuid_status != 1824 {
            unsafe { FwpmTransactionAbort0(engine) };
            return Err(format!("failed to create WFP sublayer identity: {uuid_status}"));
        }
        let mut sublayer = FWPM_SUBLAYER0::default();
        sublayer.subLayerKey = sublayer_key;
        sublayer.weight = u16::MAX;
        let sublayer_status = unsafe { FwpmSubLayerAdd0(engine, &sublayer, null_mut()) };
        if sublayer_status != 0 {
            unsafe { FwpmTransactionAbort0(engine) };
            return Err(format!("failed to add WFP sandbox sublayer: {sublayer_status}"));
        }
        let installed = install_windows_network_filters(
            engine,
            appcontainer_sid,
            &sublayer_key,
            policy,
        );
        if let Err(error) = installed {
            unsafe { FwpmTransactionAbort0(engine) };
            return Err(error);
        }
        let commit = unsafe { FwpmTransactionCommit0(engine) };
        if commit != 0 {
            unsafe { FwpmTransactionAbort0(engine) };
            return Err(format!("failed to commit WFP transaction: {commit}"));
        }
        Ok(guard)
    }
}

#[cfg(target_os = "windows")]
impl Drop for WindowsNetworkGuard {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::NetworkManagement::WindowsFilteringPlatform::FwpmEngineClose0(
                self.engine,
            );
        }
    }
}

#[cfg(target_os = "windows")]
fn install_windows_network_filters(
    engine: windows_sys::Win32::Foundation::HANDLE,
    sid: windows_sys::Win32::Security::PSID,
    sublayer_key: &windows_sys::core::GUID,
    policy: &NetworkPolicy,
) -> Result<(), String> {
    let targets = match policy {
        NetworkPolicy::Off => return Err("network guard cannot install an off policy".to_string()),
        NetworkPolicy::Loopback { ports } => ports
            .iter()
            .flat_map(|port| [(false, *port), (true, *port)])
            .collect::<Vec<_>>(),
        NetworkPolicy::Allowlist { proxy_host, proxy_port, .. } => {
            vec![(proxy_host == "::1", *proxy_port)]
        }
    };
    for (ipv6, port) in targets {
        add_windows_network_filter(engine, sid, sublayer_key, ipv6, Some(port), true)?;
    }
    // Permit 使用更高权重；随后按 package SID 阻断其余所有 IPv4/IPv6 出站。
    add_windows_network_filter(engine, sid, sublayer_key, false, None, false)?;
    add_windows_network_filter(engine, sid, sublayer_key, true, None, false)?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn add_windows_network_filter(
    engine: windows_sys::Win32::Foundation::HANDLE,
    sid: windows_sys::Win32::Security::PSID,
    sublayer_key: &windows_sys::core::GUID,
    ipv6: bool,
    port: Option<u16>,
    permit: bool,
) -> Result<(), String> {
    use windows_sys::Win32::NetworkManagement::WindowsFilteringPlatform::*;
    let mut v6_loopback = FWP_BYTE_ARRAY16 {
        byteArray16: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    };
    let mut conditions = vec![FWPM_FILTER_CONDITION0 {
        fieldKey: FWPM_CONDITION_ALE_PACKAGE_ID,
        matchType: FWP_MATCH_EQUAL,
        conditionValue: FWP_CONDITION_VALUE0 {
            r#type: FWP_SID,
            Anonymous: FWP_CONDITION_VALUE0_0 { sid: sid as *mut _ },
        },
    }];
    if let Some(port) = port {
        conditions.push(FWPM_FILTER_CONDITION0 {
            fieldKey: FWPM_CONDITION_IP_PROTOCOL,
            matchType: FWP_MATCH_EQUAL,
            conditionValue: FWP_CONDITION_VALUE0 {
                r#type: FWP_UINT8,
                Anonymous: FWP_CONDITION_VALUE0_0 { uint8: 6 },
            },
        });
        conditions.push(FWPM_FILTER_CONDITION0 {
            fieldKey: FWPM_CONDITION_IP_REMOTE_ADDRESS,
            matchType: FWP_MATCH_EQUAL,
            conditionValue: if ipv6 {
                FWP_CONDITION_VALUE0 {
                    r#type: FWP_BYTE_ARRAY16_TYPE,
                    Anonymous: FWP_CONDITION_VALUE0_0 {
                        byteArray16: &mut v6_loopback,
                    },
                }
            } else {
                FWP_CONDITION_VALUE0 {
                    r#type: FWP_UINT32,
                    Anonymous: FWP_CONDITION_VALUE0_0 {
                        uint32: u32::from_be_bytes([127, 0, 0, 1]),
                    },
                }
            },
        });
        conditions.push(FWPM_FILTER_CONDITION0 {
            fieldKey: FWPM_CONDITION_IP_REMOTE_PORT,
            matchType: FWP_MATCH_EQUAL,
            conditionValue: FWP_CONDITION_VALUE0 {
                r#type: FWP_UINT16,
                Anonymous: FWP_CONDITION_VALUE0_0 { uint16: port },
            },
        });
    }
    let mut filter = FWPM_FILTER0::default();
    filter.layerKey = if ipv6 {
        FWPM_LAYER_ALE_AUTH_CONNECT_V6
    } else {
        FWPM_LAYER_ALE_AUTH_CONNECT_V4
    };
    filter.subLayerKey = *sublayer_key;
    filter.weight = FWP_VALUE0 {
        r#type: FWP_UINT8,
        Anonymous: FWP_VALUE0_0 {
            uint8: if permit { 15 } else { 14 },
        },
    };
    filter.numFilterConditions = conditions.len() as u32;
    filter.filterCondition = conditions.as_mut_ptr();
    filter.action.r#type = if permit { FWP_ACTION_PERMIT } else { FWP_ACTION_BLOCK };
    let mut id = 0u64;
    let status = unsafe { FwpmFilterAdd0(engine, &filter, std::ptr::null_mut(), &mut id) };
    if status != 0 {
        return Err(format!("failed to add WFP sandbox filter: {status}"));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
#[derive(Debug, Deserialize, Serialize)]
struct AclJournal {
    path: String,
    original_acl: String,
    expected_acl: String,
}

#[cfg(target_os = "windows")]
impl WorkspaceAclGrant {
    fn grant(root: &str, sid: *mut core::ffi::c_void, execution_id: &str) -> Result<Self, String> {
        let mut paths = vec![std::path::PathBuf::from(root)];
        collect_workspace_acl_paths(std::path::Path::new(root), &mut paths)?;
        let mut entries = Vec::with_capacity(paths.len());
        for path in paths {
            match WorkspaceAclEntry::grant(&path, sid, execution_id) {
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
    fn grant(root: &std::path::Path, sid: *mut core::ffi::c_void, execution_id: &str) -> Result<Self, String> {
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
        };
        Self::grant_with_permissions(
            root,
            sid,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE,
            execution_id,
        )
    }

    fn grant_with_permissions(
        root: &std::path::Path,
        sid: *mut core::ffi::c_void,
        permissions: u32,
        execution_id: &str,
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
        let original_bytes = acl_bytes(old_acl)?;
        let expected_bytes = acl_bytes(new_acl)?;
        let journal_path = write_acl_journal(
            execution_id,
            &root.to_string_lossy(),
            &original_bytes,
            &expected_bytes,
        )?;
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
            let _ = std::fs::remove_file(&journal_path);
            return Err(format!(
                "failed to grant workspace access for {}: {set}",
                root.display()
            ));
        }
        Ok(Self {
            path,
            original: old_acl,
            descriptor,
            journal_path,
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
        // 恢复失败时保留 journal，下一次 Helper 启动会再次尝试；成功则删除它。
        let _ = std::fs::remove_file(&self.journal_path);
    }
}

#[cfg(target_os = "windows")]
fn acl_bytes(acl: *mut windows_sys::Win32::Security::ACL) -> Result<Vec<u8>, String> {
    if acl.is_null() {
        return Ok(Vec::new());
    }
    let size = unsafe { (*acl).AclSize as usize };
    if size == 0 || size > 16 * 1024 * 1024 {
        return Err("workspace DACL has an invalid size".to_string());
    }
    Ok(unsafe { std::slice::from_raw_parts(acl as *const u8, size) }.to_vec())
}

#[cfg(target_os = "windows")]
fn acl_journal_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("coding-agent-sandbox-acl-journal")
}

#[cfg(target_os = "windows")]
fn journal_file_name(execution_id: &str, path: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    execution_id.hash(&mut hasher);
    path.hash(&mut hasher);
    format!("acl-{:016x}.json", hasher.finish())
}

#[cfg(target_os = "windows")]
fn write_acl_journal(
    execution_id: &str,
    path: &str,
    original: &[u8],
    expected: &[u8],
) -> Result<std::path::PathBuf, String> {
    let directory = acl_journal_dir();
    std::fs::create_dir_all(&directory)
        .map_err(|_| "failed to create ACL recovery journal directory".to_string())?;
    let target = directory.join(journal_file_name(execution_id, path));
    let temporary = target.with_extension("tmp");
    let journal = AclJournal {
        path: path.to_string(),
        original_acl: STANDARD.encode(original),
        expected_acl: STANDARD.encode(expected),
    };
    let bytes = serde_json::to_vec(&journal)
        .map_err(|_| "failed to encode ACL recovery journal".to_string())?;
    use std::io::Write;
    let mut file = std::fs::File::create(&temporary)
        .map_err(|_| "failed to write ACL recovery journal".to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "failed to flush ACL recovery journal".to_string())?;
    std::fs::rename(&temporary, &target)
        .map_err(|_| "failed to commit ACL recovery journal".to_string())?;
    Ok(target)
}

#[cfg(target_os = "windows")]
fn recover_acl_journals() -> Result<(), String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, SetNamedSecurityInfoW, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{ACL, DACL_SECURITY_INFORMATION};

    let directory = acl_journal_dir();
    let entries = match std::fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("cannot inspect ACL recovery journal".to_string()),
    };
    for item in entries {
        let item = item.map_err(|_| "cannot inspect ACL recovery journal".to_string())?;
        if item.path().extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        let journal: AclJournal = serde_json::from_slice(
            &std::fs::read(item.path()).map_err(|_| "cannot read ACL recovery journal".to_string())?,
        )
        .map_err(|_| "invalid ACL recovery journal; refusing to execute".to_string())?;
        let path = widestring(&journal.path);
        let mut current_acl: *mut ACL = std::ptr::null_mut();
        let mut descriptor = std::ptr::null_mut();
        let result = unsafe {
            GetNamedSecurityInfoW(
                path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut current_acl,
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        if result != 0 {
            return Err(format!("cannot inspect journaled ACL for {}: {result}", journal.path));
        }
        let current = acl_bytes(current_acl)?;
        let expected = STANDARD
            .decode(&journal.expected_acl)
            .map_err(|_| "invalid expected ACL in recovery journal".to_string())?;
        let original = STANDARD
            .decode(&journal.original_acl)
            .map_err(|_| "invalid original ACL in recovery journal".to_string())?;
        if current != expected {
            unsafe { LocalFree(descriptor as *mut _) };
            return Err(format!(
                "ACL journal for {} no longer matches current ACL; refusing to overwrite",
                journal.path
            ));
        }
        let restored = unsafe {
            SetNamedSecurityInfoW(
                path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                if original.is_empty() {
                    std::ptr::null_mut()
                } else {
                    original.as_ptr() as *mut ACL
                },
                std::ptr::null_mut(),
            )
        };
        unsafe { LocalFree(descriptor as *mut _) };
        if restored != 0 {
            return Err(format!("failed to restore journaled ACL for {}: {restored}", journal.path));
        }
        std::fs::remove_file(item.path())
            .map_err(|_| "failed to remove recovered ACL journal".to_string())?;
    }
    Ok(())
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
    validate_network_policy(&request.network)?;
    validate_network_environment(request)?;
    #[cfg(target_os = "windows")]
    if !matches!(request.network, NetworkPolicy::Off) && !windows_network_isolation_available() {
        return Err("Windows network isolation is unavailable; refusing to execute".to_string());
    }
    #[cfg(not(target_os = "windows"))]
    if !matches!(request.network, NetworkPolicy::Off) {
        return Err("requested network capability is not available".to_string());
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
    // Helper 重新校验环境块，避免恶意键名破坏 Windows 双 NUL block 或注入
    // 额外的隐式环境；环境数量和总大小也必须有硬上限。
    if request.env.len() > 256
        || request.env.iter().any(|(key, value)| {
            key.is_empty()
                || key.contains('=')
                || key.contains('\0')
                || value.contains('\0')
                || key.len() > 1024
                || value.len() > 64 * 1024
        })
        || request
            .env
            .iter()
            .map(|(key, value)| key.len() + value.len() + 2)
            .sum::<usize>()
            > 1024 * 1024
    {
        return Err("environment block is outside helper policy".to_string());
    }
    Ok(())
}

fn validate_network_policy(policy: &NetworkPolicy) -> Result<(), String> {
    match policy {
        NetworkPolicy::Off => Ok(()),
        NetworkPolicy::Loopback { ports } => validate_network_ports(ports),
        NetworkPolicy::Allowlist { hosts, ports, proxy_id, proxy_host, proxy_port } => {
            validate_network_ports(ports)?;
            if hosts.is_empty()
                || hosts.len() > 64
                || proxy_id.is_empty()
                || proxy_id.len() > 128
                || !matches!(proxy_host.as_str(), "127.0.0.1" | "::1")
                || *proxy_port == 0
            {
                return Err("network allowlist is outside helper policy".to_string());
            }
            for host in hosts {
                if host.is_empty()
                    || host.len() > 253
                    || host.contains('\0')
                    || host != &host.to_ascii_lowercase()
                    || host.ends_with('.')
                    || host.starts_with('.')
                    || host.contains("..")
                    || !host.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'.')
                {
                    return Err("invalid network allowlist host".to_string());
                }
            }
            Ok(())
        }
    }
}

fn validate_network_environment(request: &ExecutionRequest) -> Result<(), String> {
    match &request.network {
        NetworkPolicy::Off | NetworkPolicy::Loopback { .. } => {
            if request.env.keys().any(|key| matches!(key.to_ascii_uppercase().as_str(), "HTTP_PROXY" | "HTTPS_PROXY" | "ALL_PROXY")) {
                return Err("proxy environment is forbidden by this network policy".to_string());
            }
        }
        NetworkPolicy::Allowlist { proxy_host, proxy_port, .. } => {
            let formatted_host = if proxy_host == "::1" { "[::1]" } else { proxy_host };
            let expected = format!("http://{formatted_host}:{proxy_port}");
            for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] {
                if request.env.get(key) != Some(&expected) {
                    return Err("proxy environment does not match the approved endpoint".to_string());
                }
            }
            if request.env.get("NO_PROXY").map(String::as_str) != Some("") {
                return Err("NO_PROXY must be empty for an allowlisted execution".to_string());
            }
        }
    }
    Ok(())
}

fn validate_network_ports(ports: &[u16]) -> Result<(), String> {
    if ports.is_empty() || ports.len() > 32 || ports.iter().any(|port| *port == 0) {
        return Err("invalid network port allowlist".to_string());
    }
    if ports.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err("network ports must be unique and sorted".to_string());
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

/** 只有 WFP、网络 capability SID 与回环配置 API 都可用时才声明 Windows 联网能力。 */
#[cfg(target_os = "windows")]
fn windows_network_isolation_available() -> bool {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::NetworkManagement::WindowsFilteringPlatform::{
        FwpmEngineClose0, FwpmEngineOpen0, FWPM_SESSION0, FWPM_SESSION_FLAG_DYNAMIC,
    };
    use windows_sys::Win32::NetworkManagement::WindowsFirewall::NetworkIsolationGetAppContainerConfig;
    use windows_sys::Win32::Security::{
        CreateWellKnownSid, SECURITY_MAX_SID_SIZE, SID_AND_ATTRIBUTES,
        WinCapabilityInternetClientSid,
    };
    use windows_sys::Win32::System::Rpc::RPC_C_AUTHN_WINNT;
    let mut capability_sid = vec![0u8; SECURITY_MAX_SID_SIZE as usize];
    let mut capability_size = capability_sid.len() as u32;
    if unsafe {
        CreateWellKnownSid(
            WinCapabilityInternetClientSid,
            null_mut(),
            capability_sid.as_mut_ptr() as *mut _,
            &mut capability_size,
        )
    } == 0
    {
        return false;
    }
    let mut count = 0u32;
    let mut exemptions: *mut SID_AND_ATTRIBUTES = null_mut();
    if unsafe { NetworkIsolationGetAppContainerConfig(&mut count, &mut exemptions) } != 0 {
        return false;
    }
    if !exemptions.is_null() {
        unsafe { LocalFree(exemptions as *mut _) };
    }
    let mut session = FWPM_SESSION0::default();
    session.flags = FWPM_SESSION_FLAG_DYNAMIC;
    let mut engine = null_mut();
    let status = unsafe {
        FwpmEngineOpen0(null(), RPC_C_AUTHN_WINNT, null(), &session, &mut engine)
    };
    if status != 0 || engine.is_null() {
        return false;
    }
    unsafe {
        FwpmEngineClose0(engine);
    }
    true
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
