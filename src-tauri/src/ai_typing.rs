//! "Show what the AI types": the short piece of real text (a shell command, the new code of an
//! edit) that the pet types key by key while an AI agent works.
//!
//! Safety rules, all enforced here before any text leaves the server:
//! - the setting is off by default; while it is off nothing is extracted at all;
//! - only Bash `command`, Edit `new_string`, Write `content`, MultiEdit's first `new_string`
//!   and NotebookEdit `new_source` are used;
//! - a secret filter drops the **whole** text on any hit (no partial masking);
//! - the result is whitespace-collapsed, control-character free and at most
//!   [`MAX_TYPED_CHARS`] characters long;
//! - the text is never written to any log.

use regex::Regex;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

/// Characters the pet types at most per event.
pub const MAX_TYPED_CHARS: usize = 80;
/// The secret filter looks at this many characters of the field (before trimming).
const FILTER_SCAN_CHARS: usize = 4_000;

static SHOW_AI_TYPING: AtomicBool = AtomicBool::new(false);

/// Mirrors the `showAiTyping` setting; updated by `config::load_settings` / `try_save_settings`.
pub fn set_enabled(on: bool) {
    SHOW_AI_TYPING.store(on, Ordering::Relaxed);
}

pub fn enabled() -> bool {
    SHOW_AI_TYPING.load(Ordering::Relaxed)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ToolFamily {
    Edit,
    Command,
}

/// Same families as `mcp::label_for_tool` uses for "coding" and "running a command".
fn tool_family(tool_name: &str) -> Option<ToolFamily> {
    let lower = tool_name.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return None;
    }
    if ["edit", "write", "patch", "replace", "notebook"]
        .iter()
        .any(|k| lower.contains(k))
    {
        Some(ToolFamily::Edit)
    } else if ["command", "bash", "shell", "exec", "terminal"]
        .iter()
        .any(|k| lower.contains(k))
    {
        Some(ToolFamily::Command)
    } else {
        None
    }
}

fn str_field<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(|v| v.as_str())
}

/// The raw field to type for a tool, before filtering and trimming.
fn raw_field<'a>(family: ToolFamily, input: &'a Value) -> Option<&'a str> {
    match family {
        ToolFamily::Command => str_field(input, "command"),
        ToolFamily::Edit => str_field(input, "new_string")
            .or_else(|| str_field(input, "content"))
            .or_else(|| {
                input
                    .get("edits")
                    .and_then(|e| e.as_array())
                    .and_then(|a| a.first())
                    .and_then(|first| str_field(first, "new_string"))
            })
            .or_else(|| str_field(input, "new_source")),
    }
}

/// Extracts the text to type from a hook's tool input, or None (setting off, other tool,
/// nothing usable, or the secret filter hit).
pub fn extract_typed_text(tool_name: &str, tool_input: Option<&Value>) -> Option<String> {
    if !enabled() {
        return None;
    }
    extract_typed_text_unchecked(tool_name, tool_input?)
}

/// Why `extract_typed_text` gave nothing, as a short code for the opt-in debug log (never the
/// text itself): "disabled", "no_input", "other_tool", "no_field", "secret_path",
/// "secret_filter:<ids>", "empty" or "ok".
pub fn diagnose(tool_name: &str, tool_input: Option<&Value>) -> String {
    diagnose_with(enabled(), tool_name, tool_input)
}

fn diagnose_with(on: bool, tool_name: &str, tool_input: Option<&Value>) -> String {
    if !on {
        return "disabled".into();
    }
    let Some(input) = tool_input else { return "no_input".into() };
    let Some(family) = tool_family(tool_name) else { return "other_tool".into() };
    let Some(raw) = raw_field(family, input) else { return "no_field".into() };
    if family == ToolFamily::Edit {
        let path = str_field(input, "file_path")
            .or_else(|| str_field(input, "notebook_path"))
            .or_else(|| str_field(input, "path"))
            .unwrap_or("");
        if is_secret_path(path) {
            return "secret_path".into();
        }
    }
    let scan: String = raw.chars().take(FILTER_SCAN_CHARS).collect();
    if looks_secret(&scan) {
        let mut ids: Vec<String> = round2_hits(&scan).iter().map(|s| s.to_string()).collect();
        if ids.is_empty() {
            ids.push("base".into());
        }
        return format!("secret_filter:{}", ids.join(","));
    }
    if trim_typed(&scan).is_none() {
        return "empty".into();
    }
    "ok".into()
}

// ---- Opt-in debug log ------------------------------------------------------------------
// Off by default. It is on only while the file `agent-debug.flag` exists in the settings folder.
// It records where an AI event goes (stage + short codes + counts), never any text.

const DEBUG_LOG_MAX_BYTES: u64 = 256 * 1024;

fn debug_flag_path() -> std::path::PathBuf {
    crate::config::app_data_dir().join("agent-debug.flag")
}

pub fn debug_enabled() -> bool {
    debug_flag_path().exists()
}

/// Appends `<epoch_ms> pid=<pid> <stage> <detail>` to `agent-debug.log` when the flag file
/// exists. `detail` must only hold codes, names and counts: never typed text or tool input.
pub fn debug_log(stage: &str, detail: &str) {
    if !debug_enabled() {
        return;
    }
    use std::io::Write;
    let path = crate::config::app_data_dir().join("agent-debug.log");
    if std::fs::metadata(&path).map(|m| m.len() > DEBUG_LOG_MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // One line per entry, whatever the caller passed.
    let detail: String = detail.chars().filter(|c| !c.is_control()).take(300).collect();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{ms} pid={} {stage} {detail}", std::process::id());
    }
}

fn extract_typed_text_unchecked(tool_name: &str, input: &Value) -> Option<String> {
    let family = tool_family(tool_name)?;
    let raw = raw_field(family, input)?;
    if family == ToolFamily::Edit {
        let path = str_field(input, "file_path")
            .or_else(|| str_field(input, "notebook_path"))
            .or_else(|| str_field(input, "path"))
            .unwrap_or("");
        if is_secret_path(path) {
            return None;
        }
    }
    filter_and_trim(raw)
}

/// For an event that already carries a typed text (e.g. from `--hook` or `/agent/event`):
/// applies the setting, the secret filter and the trim again.
pub fn sanitize_forwarded(text: &str) -> Option<String> {
    if !enabled() {
        return None;
    }
    filter_and_trim(text)
}

fn filter_and_trim(raw: &str) -> Option<String> {
    let scan: String = raw.chars().take(FILTER_SCAN_CHARS).collect();
    if looks_secret(&scan) {
        return None;
    }
    trim_typed(&scan)
}

/// Collapses whitespace runs to one space, drops control characters, keeps the first
/// [`MAX_TYPED_CHARS`] characters. Empty after that: None.
pub fn trim_typed(raw: &str) -> Option<String> {
    let mut out = String::new();
    let mut count = 0usize;
    let mut pending_space = false;
    for ch in raw.chars() {
        if ch.is_whitespace() {
            pending_space = count > 0;
            continue;
        }
        if ch.is_control() {
            continue;
        }
        if pending_space {
            if count + 1 >= MAX_TYPED_CHARS {
                break;
            }
            out.push(' ');
            count += 1;
            pending_space = false;
        }
        out.push(ch);
        count += 1;
        if count >= MAX_TYPED_CHARS {
            break;
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn is_secret_path(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    [
        ".env", ".pem", ".key", ".pfx", ".jks", "id_rsa", "id_ed25519", "credentials", "secret",
        "token", "password",
    ]
    .iter()
    .any(|needle| p.contains(needle))
}

struct SecretRules {
    patterns: Vec<Regex>,
    long_run: Regex,
    env_line: Regex,
    /// Round 2 (R1, R2, R4, R5, R7); R3 and R6 are code below.
    round2: Vec<(&'static str, Regex)>,
    digit_run: Regex,
}

fn rules() -> &'static SecretRules {
    static RULES: OnceLock<SecretRules> = OnceLock::new();
    RULES.get_or_init(|| {
        let p = [
            // A secret-ish name followed by '=', ':' or a space and a value.
            r#"(?i)(password|passwd|pwd|secret|token|api[_-]?key|apikey|auth|authorization|bearer|credential|private[_-]?key|access[_-]?key|session|cookie|pzwd)[a-z0-9_-]*["']?\s*[=:\s]\s*["']?[^\s"']+"#,
            // -p<value> (mysql style) and --password / --token style flags.
            r"(^|\s)-p[^\s-]",
            r"(?i)--(password|passwd|pass|pwd|token|secret|api[_-]?key|auth)\b",
            // user:pass@host in URLs and user/pass@host connect strings (sqlplus style).
            r"[A-Za-z][A-Za-z0-9+.-]*://[^\s/:@]+:[^\s/@]+@",
            r"(^|\s)[A-Za-z0-9_.-]+/[^\s/@]+@[A-Za-z0-9_.:-]+",
            // Known token shapes.
            r"\bsk-[A-Za-z0-9_-]{6,}",
            r"\b(ghp|gho|ghu|ghs)_[A-Za-z0-9]{6,}",
            r"\bgithub_pat_",
            r"\bAKIA[0-9A-Z]{8,}",
            r"\bxox[bp]-",
            r"\beyJ[A-Za-z0-9_-]{6,}",
            r"-----BEGIN",
        ];
        let round2: [(&'static str, &'static str); 12] = [
            // R1: NAME=value / NAME: value where NAME holds a secret-ish part.
            (
                "R1",
                r#"(?i)[A-Za-z0-9_.-]*(pass|pw|pwd|passphrase|secret|token|key|auth|cred|session|cookie|pin|otp)[A-Za-z0-9_.-]*["']?\s*(=|:)\s*\S"#,
            ),
            // R2 (shell form only): export / set NAME=value with '=' right after the name,
            // export of an ALL-CAPS name (with or without a value), $env:NAME = value, and a
            // capital NAME=value at the start of a command. JS/TS exports (`export default`,
            // `export const x = ...`, `export { a }`) are not shell and type; R1 still catches
            // secret-looking names there.
            ("R2", r"(?i)(^|[\s;&|(])(export|set)\s+[A-Za-z_][A-Za-z0-9_]*="),
            ("R2", r"(^|[\s;&|(])export\s+[A-Z][A-Z0-9_]*(\s|$)"),
            ("R2", r"(?i)\$env:[A-Za-z_][A-Za-z0-9_]*\s*="),
            ("R2", r"(^|[;&|(]\s*|\n\s*)\s*[A-Z][A-Z0-9_]*=\S"),
            // R4: any userinfo in a URL, with or without a colon.
            ("R4", r"(?i)[a-z][a-z0-9+.-]*://[^\s/@]+@"),
            // R5: more token shapes.
            ("R5", r"(?i)\b(sk|rk|pk)_(live|test)_"),
            ("R5", r"(?i)\bSG\.[A-Za-z0-9_.-]{16,}"),
            (
                "R5",
                r"(?i)(\bglpat-|\bhf_[A-Za-z0-9]|\baiza[A-Za-z0-9_-]|\bya29\.|\bnpm_[A-Za-z0-9]|\bshpat_|\bdop_v1_|\bxox[as]-)",
            ),
            // R7: secret words anywhere, with or without a value (English and Thai).
            (
                "R7",
                r"(?i)(password|passwd|passphrase|passcode|secret|credential|pgpassword|\bpw\b|รหัสผ่าน|พาสเวิร์ด|รหัสลับ|โทเคน|กุญแจลับ)",
            ),
            // R3 helpers live in `sensitive_tool`; R6 in `digit_run`.
            ("R2", r"(?m)^\s*(export\s+)?[A-Z][A-Z0-9_]*=\S"),
            ("R4", r"(?i)\b(ftp|sftp|ssh|smb|ldap|mongodb(\+srv)?|redis|amqp|postgres(ql)?|mysql)://\S*@"),
        ];
        SecretRules {
            patterns: p.iter().map(|s| Regex::new(s).expect("secret rule")).collect(),
            long_run: Regex::new(r"[A-Za-z0-9+/=_-]{24,}").expect("long run rule"),
            env_line: Regex::new(r"(?m)^\s*(export\s+)?[A-Z][A-Z0-9_]*=\S").expect("env rule"),
            round2: round2
                .iter()
                .map(|(id, s)| (*id, Regex::new(s).expect("round 2 rule")))
                .collect(),
            // R6: 13+ digits, spaces or dashes allowed between them.
            digit_run: Regex::new(r"\d(?:[ -]?\d){12,}").expect("digit rule"),
        }
    })
}

/// R3: a sensitive tool used as a command word (start of a segment, after |, &&, ;, sudo,
/// xargs, env or NAME=value prefixes).
fn sensitive_tool(text: &str) -> bool {
    for segment in text.split(|c| c == '|' || c == ';' || c == '&' || c == '\n' || c == '(') {
        let words: Vec<String> = segment
            .split_whitespace()
            .map(|w| w.trim_matches(|c| c == '"' || c == '\'').to_ascii_lowercase())
            .collect();
        let mut i = 0;
        while i < words.len() {
            let w = words[i].as_str();
            if w == "sudo" {
                // `sudo -S` reads a password from stdin.
                let mut j = i + 1;
                while j < words.len() && words[j].starts_with('-') {
                    if words[j] == "-s" || words[j] == "--stdin" {
                        return true;
                    }
                    j += 1;
                }
                i = j;
            } else if w == "xargs" || w == "env" || w == "command" || w == "exec" || w == "time" {
                i += 1;
            } else if w.contains('=') && !w.starts_with('-') {
                i += 1;
            } else {
                break;
            }
        }
        if i >= words.len() {
            continue;
        }
        let raw_cmd = words[i].as_str();
        let base = raw_cmd.rsplit(['/', '\\']).next().unwrap_or(raw_cmd);
        let cmd = base.strip_suffix(".exe").unwrap_or(base);
        let args = &words[i + 1..];
        let first = args.first().map(String::as_str).unwrap_or("");
        let second = args.get(1).map(String::as_str).unwrap_or("");
        let has = |pred: &dyn Fn(&str) -> bool| args.iter().any(|a| pred(a.as_str()));
        let hit = match cmd {
            "sshpass" | "openssl" | "gpg" | "gpg2" | "ssh-keygen" | "ssh-add" | "sqlplus"
            | "htpasswd" | "su" | "vault" | "op" | "pass" | "security" | "certutil"
            | "keytool" => true,
            "docker" | "podman" => first == "login",
            "redis-cli" => has(&|a| a == "-a" || a == "-u" || a.starts_with("--pass") || a.starts_with("--askpass")),
            "mysql" | "mariadb" | "mysqldump" | "mysqladmin" => {
                has(&|a| a.starts_with("-p") || a.starts_with("--pass"))
            }
            "psql" | "pg_dump" | "pg_restore" => {
                has(&|a| a.contains("://")) || text.to_ascii_lowercase().contains("pgpassword")
            }
            "mongosh" | "mongo" => has(&|a| a.starts_with("-p") || a.starts_with("--pass") || a.contains("://")),
            "curl" | "wget" => has(&|a| {
                a == "-u"
                    || a.starts_with("-u") && a.len() > 2 && !a.starts_with("-url")
                    || a.starts_with("--user")
                    || a.starts_with("--pass")
                    || a.starts_with("--http-user")
                    || a.starts_with("--http-pass")
                    || a == "-h"
                    || a.starts_with("--header")
                    || a.starts_with("--oauth2-bearer")
            }),
            "az" => first == "login",
            "aws" => first == "configure",
            "gcloud" => first == "auth",
            "gh" => first == "auth",
            "npm" | "pnpm" | "yarn" => matches!(first, "login" | "adduser" | "token"),
            "git" => first == "credential",
            "kubectl" => {
                (first == "create" && second == "secret")
                    || (first == "config" && second == "set-credentials")
            }
            "net" => first == "use",
            _ => false,
        };
        if hit {
            return true;
        }
    }
    false
}

/// The round-2 rule ids that hit, for tests ("R1".."R7").
fn round2_hits(text: &str) -> Vec<&'static str> {
    let r = rules();
    let mut hits: Vec<&'static str> = Vec::new();
    for (id, re) in &r.round2 {
        if re.is_match(text) && !hits.contains(id) {
            hits.push(id);
        }
    }
    if sensitive_tool(text) {
        hits.push("R3");
    }
    if r.digit_run.is_match(text) {
        hits.push("R6");
    }
    hits
}

/// True when the text looks like it holds a secret. Whole-text decision: any hit drops it.
/// When in doubt, drop: a dropped text only costs the typing animation.
pub fn looks_secret(text: &str) -> bool {
    let r = rules();
    if r.patterns.iter().any(|re| re.is_match(text)) {
        return true;
    }
    let long_mixed = r.long_run.find_iter(text).any(|m| {
        let s = m.as_str();
        s.chars().any(|c| c.is_ascii_alphabetic()) && s.chars().any(|c| c.is_ascii_digit())
    });
    if long_mixed {
        return true;
    }
    if r.env_line.find_iter(text).count() >= 2 {
        return true;
    }
    !round2_hits(text).is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Concatenate parts at runtime (keeps provider-shaped literals out of source).
    fn j(parts: &[&str]) -> String {
        parts.concat()
    }

    fn typed(tool: &str, input: Value) -> Option<String> {
        extract_typed_text_unchecked(tool, &input)
    }

    #[test]
    fn extracts_the_documented_fields() {
        assert_eq!(typed("Bash", json!({"command": "git status"})).as_deref(), Some("git status"));
        assert_eq!(
            typed("Edit", json!({"file_path": "src/a.ts", "old_string": "x", "new_string": "let a = 1;"})).as_deref(),
            Some("let a = 1;")
        );
        assert_eq!(typed("Write", json!({"file_path": "a.md", "content": "hello"})).as_deref(), Some("hello"));
        assert_eq!(
            typed("MultiEdit", json!({"file_path": "a.rs", "edits": [{"new_string": "first"}, {"new_string": "second"}]})).as_deref(),
            Some("first")
        );
        assert_eq!(
            typed("NotebookEdit", json!({"notebook_path": "n.ipynb", "new_source": "print(1)"})).as_deref(),
            Some("print(1)")
        );
        assert_eq!(typed("run_shell_command", json!({"command": "ls"})).as_deref(), Some("ls"));
    }

    #[test]
    fn other_tools_type_nothing() {
        for tool in ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "Task", ""] {
            assert_eq!(typed(tool, json!({"command": "ls", "content": "x", "pattern": "y"})), None, "{tool}");
        }
    }

    #[test]
    fn setting_off_extracts_nothing() {
        set_enabled(false);
        assert_eq!(extract_typed_text("Bash", Some(&json!({"command": "git status"}))), None);
        assert_eq!(sanitize_forwarded("git status"), None);
    }

    #[test]
    fn trims_whitespace_controls_and_length() {
        assert_eq!(trim_typed("  a \n\n\t b\u{7}c  ").as_deref(), Some("a bc"));
        assert_eq!(trim_typed(" \n\t "), None);
        let long: String = "abc ".repeat(200);
        let t = trim_typed(&long).unwrap();
        assert!(t.chars().count() <= MAX_TYPED_CHARS);
        assert!(t.starts_with("abc abc"));
        let thai = "สวัสดีครับ".repeat(20);
        let t = trim_typed(&thai).unwrap();
        assert_eq!(t.chars().count(), MAX_TYPED_CHARS);
    }

    #[test]
    fn filter_names_and_flags() {
        assert!(looks_secret(r#"curl -H "Authorization: Bearer abcdef""#));
        assert!(looks_secret("mysql -uroot -pS3cret db"));
        assert!(looks_secret("export API_KEY=abc123"));
        assert!(looks_secret("password = hunter2"));
        assert!(looks_secret("tool --password hunter2"));
        assert!(looks_secret("set pzwd: x"));
        assert!(looks_secret("cookie: a=b"));
    }

    #[test]
    fn filter_user_pass_hosts() {
        assert!(looks_secret("git clone https://bob:hunter2@example.com/repo.git"));
        assert!(looks_secret("sqlplus scott/tiger@orcl"));
    }

    #[test]
    fn filter_token_shapes() {
        assert!(looks_secret("OPENAI=sk-abcdefghijkl"));
        // Token-shaped fakes are assembled at runtime so no provider-shaped
        // literal sits in the source (GitHub push protection).
        assert!(looks_secret(&j(&["gh", "p_abcdefghij"])));
        assert!(looks_secret(&j(&["gh", "o_abcdefghij"])));
        assert!(looks_secret(&j(&["github", "_pat_11AAA"])));
        assert!(looks_secret(&j(&["AK", "IAIOSFODNN7EXAMPLE"])));
        assert!(looks_secret(&j(&["xo", "xb-123"])));
        assert!(looks_secret(&j(&["xo", "xp-123"])));
        assert!(looks_secret(&j(&["ey", "JhbGciOiJIUzI1NiJ9.", "ey", "JzdWIiOiIxIn0.abc"])));
        assert!(looks_secret(&j(&["-----BEGIN", " RSA PRIVATE", " KEY-----\nMIIB"])));
    }

    #[test]
    fn filter_long_mixed_runs() {
        assert!(looks_secret("echo 3f2a9c4b1e8d7f6a5b4c3d2e1f0a9b8c7d6e5f4a"));
        assert!(looks_secret("data QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Ng=="));
        // Long but letters only: not a secret shape.
        assert!(!looks_secret("abcdefghijklmnopqrstuvwxyzabcdef"));
    }

    #[test]
    fn filter_env_like_content() {
        assert!(looks_secret("DB_HOST=localhost\nDB_NAME=app\n"));
        // Round 2 (R2): a single capital NAME=value line drops too.
        assert!(looks_secret("DB_HOST=localhost"));
    }

    #[test]
    fn filter_secret_paths() {
        assert_eq!(typed("Write", json!({"file_path": "/app/.env", "content": "hello"})), None);
        assert_eq!(typed("Edit", json!({"file_path": "config/credentials.json", "new_string": "x"})), None);
        assert_eq!(typed("Write", json!({"file_path": "certs/server.pem", "content": "x"})), None);
        assert_eq!(typed("Write", json!({"file_path": "C:\\Users\\a\\.ssh\\id_ed25519", "content": "x"})), None);
        assert_eq!(typed("Edit", json!({"file_path": "src/secret_store.ts", "new_string": "x"})), None);
    }

    #[test]
    fn harmless_look_alikes_still_type() {
        assert!(!looks_secret("git log --oneline -5"));
        assert!(!looks_secret("npm run build"));
        assert!(!looks_secret("const total = price * qty;"));
        assert!(!looks_secret("mkdir -p src/utils"));
        assert!(!looks_secret("npm i @types/node@20"));
        assert_eq!(typed("Bash", json!({"command": "git log --oneline -5"})).as_deref(), Some("git log --oneline -5"));
        assert_eq!(
            typed("Edit", json!({"file_path": "src/cart.ts", "new_string": "const total = price * qty;"})).as_deref(),
            Some("const total = price * qty;")
        );
    }

    #[test]
    fn filter_drops_whole_text_not_a_part() {
        assert_eq!(typed("Bash", json!({"command": "echo hi && mysql -pS3cret"})), None);
    }

    #[test]
    fn filter_scans_beyond_the_typed_part() {
        let cmd = format!("{} --password hunter2", "a ".repeat(100));
        assert_eq!(typed("Bash", json!({ "command": cmd })), None);
    }
    // ---- Round 2 (R1-R7). All values are fake. ----

    fn hits(text: &str) -> Vec<&'static str> {
        round2_hits(text)
    }

    #[test]
    fn r1_assignment_names() {
        for t in ["pw=FAKEpw1", "pass=FAKE", "DB_PASS=FAKE", "KEY=FAKE", "x-api-key: FAKE", "otp = 123", "my_pin: 0000", "sessionCookie=abc"] {
            assert!(hits(t).contains(&"R1"), "{t}");
            assert!(looks_secret(t), "{t}");
        }
    }

    #[test]
    fn r2_is_shell_form_only() {
        for t in ["export default function App() {", "export const total = price * qty;", "export { a, b };", "export function f() {}", "export class A {}", "export * from './x';", "export let n = 1;"] {
            assert!(!hits(t).contains(&"R2"), "{t}");
            assert!(!looks_secret(t), "must type: {t} (hits {:?})", hits(t));
        }
        assert!(hits("export API_URL=http://x").contains(&"R2"));
        assert!(looks_secret("export API_URL=http://x"));
        // A secret-looking JS export is still caught, by R1.
        assert!(hits("export const apiKey = 123;").contains(&"R1"));
        assert!(looks_secret("export const apiKey = 123;"));
    }

    #[test]
    fn r2_shell_assignments() {
        for t in ["export DB_PASS=FAKE", "export PATH=/usr/bin", "export FAKEKEY", "set FOO=bar", "$env:FAKE_TOKEN = 'x'", "FOO=bar make", "ls && FOO=bar make"] {
            assert!(hits(t).contains(&"R2"), "{t}");
        }
    }

    #[test]
    fn r3_sensitive_tools() {
        for t in [
            "sshpass -p FAKE ssh host", "docker login -u bob -p FAKE", "podman login reg",
            "redis-cli -a FAKE", "openssl enc -k FAKE", "gpg --passphrase FAKE", "gpg2 -d f",
            "ssh-keygen -N FAKE", "ssh-add key", "mysql -u root -pFAKE", "mysqldump --password=FAKE db",
            "psql postgres://h/db", "sqlplus scott", "mongosh -p FAKE", "mongo mongodb://h",
            "curl -u bob:FAKE https://x.test", "curl --user bob:FAKE https://x.test",
            "curl -H 'X: y' https://x.test", "wget --http-password=FAKE https://x.test",
            "curl --oauth2-bearer FAKE https://x", "htpasswd -b f u FAKE", "echo FAKE | sudo -S ls",
            "su root", "az login -u a", "aws configure", "gcloud auth login", "gh auth login",
            "npm login", "npm adduser", "npm token create", "git credential fill", "vault read x",
            "kubectl create secret generic x", "kubectl config set-credentials u", "op read x",
            "pass show x", "security find-generic-password", "certutil -p x", "keytool -list",
            r"net use \\h\s", "ls | xargs openssl", "cd x && sudo openssl rand 4",
            r"C:\tools\openssl.exe rand 4",
        ] {
            assert!(sensitive_tool(t), "{t}");
            assert!(looks_secret(t), "{t}");
        }
        assert!(!sensitive_tool("docker ps"));
        assert!(!sensitive_tool("curl https://example.com"));
        assert!(!sensitive_tool("mysql -u root db"));
    }

    #[test]
    fn r4_any_url_userinfo() {
        for t in ["git clone https://FAKEabc@github.com/o/r.git", "https://bob@x.test", "ssh://u:FAKE@h"] {
            assert!(hits(t).contains(&"R4"), "{t}");
        }
        assert!(!hits("git remote add origin git@github.com:user/repo.git").contains(&"R4"));
    }

    #[test]
    fn r5_more_token_shapes() {
        for t in [
            j(&["sk_", "live_FAKE123"]), j(&["sk_", "test_FAKEabcdefgh"]),
            j(&["rk_", "live_FAKE"]), j(&["pk_", "live_FAKE"]),
            j(&["S", "G.FAKEabcdefghijkl.mnopqr"]), j(&["gl", "pat-FAKE"]),
            j(&["h", "f_FAKEabc"]), j(&["AI", "zaFAKE123"]),
            j(&["ya", "29.FAKE"]), j(&["np", "m_FAKEabc"]),
            j(&["sh", "pat_FAKE"]), j(&["do", "p_v1_FAKE"]),
            j(&["xo", "xa-1"]), j(&["xo", "xs-1"]),
        ] {
            assert!(hits(&t).contains(&"R5"), "{t}");
        }
    }

    #[test]
    fn r6_digit_runs() {
        for t in ["echo 12345678901234567890123456789012", "4111 1111 1111 1111", "4111-1111-1111-1111", "id 1234567890123"] {
            assert!(hits(t).contains(&"R6"), "{t}");
        }
        assert!(!hits("id 123456789012").contains(&"R6"));
    }

    #[test]
    fn r7_secret_words_incl_thai() {
        for t in [
            "the password field", "passwd", "passphrase", "my passcode", "my login is bob and pw FAKE",
            "top secret", "credentials.json", "รหัสผ่านคือ FAKE", "พาสเวิร์ด", "รหัสลับ", "โทเคน", "กุญแจลับ",
        ] {
            assert!(hits(t).contains(&"R7"), "{t}");
        }
        assert!(!hits("pwd_helper").contains(&"R7"));
    }

    /// Known limit (stated in the PR): a bare secret with no keyword nearby, here a short
    /// string literal, is not recognised and types. Dropping every such literal would stop
    /// almost all ordinary code edits from typing.
    #[test]
    fn known_limit_bare_literal_without_keyword_types() {
        let t = "const k = 'TESTONLYshort';";
        assert!(!looks_secret(t), "hits {:?}", hits(t));
        assert_eq!(typed("Edit", json!({"file_path": "src/a.ts", "new_string": t})).as_deref(), Some(t));
    }

    /// Every false negative qa2 found at 365c8c7 (fn-probe.txt) must now drop, except the
    /// known limit `const k = 'TESTONLYshort';` (see the test above).
    #[test]
    fn qa2_fn_probe_all_drop() {
        let probe = [
            "export DB_PASS=TESTONLYpw",
            "export DB_PASS TESTONLYpw",
            "pw=TESTONLYpw",
            "pass=TESTONLYpw",
            "sshpass -p TESTONLYpw ssh host",
            "docker login -u bob -p TESTONLYpw",
            "curl -u bob:TESTONLYpw https://x.test",
            "redis-cli -a TESTONLYpw",
            "openssl enc -k TESTONLYpw",
            "git clone https://TESTONLYabc@github.com/o/r.git",
            "echo 12345678901234567890123456789012",
            "export KEY=TESTONLYkey",
            "export TESTONLYKEY",
            "mysql -u root --pass TESTONLYpw",
            "mysql -u root --pass=TESTONLYpw",
            "รหัสผ่านคือ TESTONLYpw",
            "my login is bob and pw TESTONLYpw",
            "PGPASSWORD=TESTONLYpw psql",
            "export AWS_SECRET_ACCESS_KEY=TESTONLY",
            "echo 'TESTONLYpw' | sudo -S ls",
            "az login --password TESTONLYpw",
            "curl --user bob:TESTONLYpw https://x.test",
            "wget --http-user=bob --http-password=TESTONLYpw https://x.test",
            "npm config set //registry/:_authToken TESTONLYtok",
            "Authorization: Basic dXNlcjpwYXNz",
            "ssh-keygen -N TESTONLYpass",
            "gpg --passphrase TESTONLYpass",
            "export GITHUB_TOKEN=TESTONLY",
            "x-api-key: TESTONLY",
            &j(&["const k = 'sk_", "live_TESTONLY1234567890abcdef';"]),
            &j(&["stripe sk_", "test_TESTONLYabcdefgh"]),
            &j(&["S", "G.TESTONLYabcdefghijkl.mnopqr"]),
        ];
        for t in probe {
            assert!(looks_secret(t), "must drop: {t}");
            assert_eq!(typed("Bash", json!({ "command": t })), None, "{t}");
        }
    }

    /// The spec's DROP examples still drop.
    #[test]
    fn spec_drop_examples_still_drop() {
        for t in [
            r#"curl -H "Authorization: Bearer abcFAKE""#,
            "mysql -pS3cretFAKE",
            "export API_KEY=FAKE",
            &j(&["ey", "JhbGciOiJIUzI1NiJ9.", "ey", "JzdWIiOiJmYWtlIn0.fakesig"]),
            "0123456789abcdef0123456789abcdef01234567",
            "sqlplus fakeuser/fakepass@fakehost",
            &j(&["-----BEGIN", " PRIVATE KEY-----"]),
        ] {
            assert!(looks_secret(t), "{t}");
        }
        assert_eq!(typed("Write", json!({"file_path": "/app/.env", "content": "hello"})), None);
        assert_eq!(typed("Edit", json!({"file_path": "config/credentials.json", "new_string": "hello"})), None);
    }

    /// Thai is not a reason to drop: Thai prose, Thai with Latin code words, Thai in a Bash
    /// command and in a Write body all pass the filter and are typed (up to 80 characters).
    #[test]
    fn thai_text_types() {
        for t in [
            "แก้ไขไฟล์ตามที่ขอเรียบร้อยแล้วครับ",
            "echo สวัสดีครับ",
            "git commit -m \"แก้บั๊กการแสดงผล\"",
            "// ตรวจสอบว่าผู้ใช้ล็อกอินอยู่หรือไม่\nconst a = 1;",
            "# คำอธิบายการใช้งาน: ติดตั้งแล้วรัน npm run dev",
            "ตั้งค่าคีย์ลัดใหม่",
        ] {
            assert!(!looks_secret(t), "must type: {t}");
            let out = typed("Write", json!({"file_path": "notes.md", "content": t})).unwrap();
            assert!(out.chars().count() <= MAX_TYPED_CHARS);
            assert!(out.chars().any(|c| ('\u{0E00}'..='\u{0E7F}').contains(&c)), "{t}");
            assert!(typed("Bash", json!({"command": t})).is_some(), "{t}");
        }
        // Long Thai text is cut by characters (a byte cut would split a 3-byte character).
        let long = "ก".repeat(500);
        assert_eq!(
            typed("Write", json!({"file_path": "a.md", "content": long})).unwrap().chars().count(),
            MAX_TYPED_CHARS
        );
    }

    /// `diagnose` names the reason a text is not typed, never the text.
    #[test]
    fn diagnose_reasons() {
        assert_eq!(diagnose_with(true, "Read", Some(&json!({"command": "ls"}))), "other_tool");
        assert_eq!(diagnose_with(true, "Bash", None), "no_input");
        assert_eq!(diagnose_with(true, "Bash", Some(&json!({}))), "no_field");
        assert_eq!(diagnose_with(true, "Write", Some(&json!({"file_path": ".env", "content": "x"}))), "secret_path");
        assert!(diagnose_with(true, "Bash", Some(&json!({"command": "export API_KEY=x"}))).starts_with("secret_filter:"));
        assert_eq!(diagnose_with(true, "Bash", Some(&json!({"command": " \n "}))), "empty");
        assert_eq!(diagnose_with(true, "Bash", Some(&json!({"command": "สวัสดี"}))), "ok");
        assert_eq!(diagnose_with(false, "Bash", Some(&json!({"command": "ls"}))), "disabled");
    }

    /// Ordinary words in the base rule's list ("auth", "session", "token", "cookie") followed by
    /// any word drop the whole text, in English and in Thai alike (found while debugging "the
    /// keycaps do not show"). Documents today's behaviour; the opt-in debug log shows it as
    /// `why_no_text=secret_filter:base`.
    #[test]
    fn known_over_drop_is_language_independent() {
        for t in ["fix auth bug in login flow", "แก้ไข auth middleware ให้ถูกต้อง", "ตรวจสอบ session ของผู้ใช้"] {
            assert!(looks_secret(t), "{t}");
        }
        assert_eq!(diagnose_with(true, "Bash", Some(&json!({"command": "fix auth bug"}))), "secret_filter:base");
        assert_eq!(diagnose_with(true, "Bash", Some(&json!({"command": "ตรวจสอบ session ของผู้ใช้"}))), "secret_filter:base");
    }

    /// These must still type (spec + qa-lead acceptance).
    #[test]
    fn must_still_type() {
        for t in [
            "git log --oneline -5",
            "npm run build",
            "const total = price * qty;",
            "git status",
            "ls -la",
            "cargo test",
            r#"print("hello")"#,
            "const title = 'Save File';",
            r#"print("Hello World")"#,
            "export default function App() {",
            "export const total = price * qty;",
            "export { a, b };",
        ] {
            assert!(!looks_secret(t), "must type: {t} (hits {:?})", hits(t));
            assert_eq!(typed("Bash", json!({ "command": t })).as_deref(), Some(t));
        }
    }
}
