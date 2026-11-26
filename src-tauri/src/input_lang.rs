//! Active keyboard input language (Windows only).
//!
//! The keyboard picture follows the input language of the window in front, not the UI
//! language: Thai input shows the Thai Kedmanee legends and bubbles, anything else the Latin
//! ones. A background thread polls `GetKeyboardLayout` of the foreground window's thread every
//! 250 ms and emits `kuro-input-lang` with `{ "lang": "<iso-639-1>" }` only when it changes
//! (plus once at start-up). The payload carries no key or text data, so password privacy is
//! unaffected. `ToUnicode` is never called (it would disturb dead-key state in other apps).
//!
//! macOS and Linux: no watcher; `current()` stays `None` and the front end keeps its UI-language rule.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

static CURRENT: Mutex<Option<String>> = Mutex::new(None);

/// The last detected input language (ISO 639-1, lower case), or `None` when unknown / not Windows.
pub fn current() -> Option<String> {
    CURRENT.lock().ok().and_then(|g| g.clone())
}

/// JSON payload of `kuro-input-lang` (also the OBS `inputLang` event).
pub fn payload_json(lang: &str) -> String {
    serde_json::json!({ "lang": lang }).to_string()
}

#[cfg_attr(not(windows), allow(dead_code))]
fn store(lang: &str) -> bool {
    let mut guard = match CURRENT.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    if guard.as_deref() == Some(lang) {
        return false;
    }
    *guard = Some(lang.to_string());
    true
}

/// ISO 639-1 code for a Windows LANGID (low word of an HKL). Thai (primary 0x1E) is always "th".
#[cfg_attr(not(windows), allow(dead_code))]
pub fn code_for_langid(langid: u16) -> String {
    let primary = langid & 0x3ff;
    if primary == 0x1e {
        return "th".to_string();
    }
    #[cfg(windows)]
    if let Some(code) = win_impl::iso639_for_lcid(langid as u32) {
        return code;
    }
    fallback_code(primary).to_string()
}

/// Small built-in table used when the OS cannot name the language.
#[cfg_attr(not(windows), allow(dead_code))]
fn fallback_code(primary: u16) -> &'static str {
    match primary {
        0x04 => "zh",
        0x07 => "de",
        0x09 => "en",
        0x0a => "es",
        0x0c => "fr",
        0x10 => "it",
        0x11 => "ja",
        0x12 => "ko",
        0x13 => "nl",
        0x16 => "pt",
        0x19 => "ru",
        0x1e => "th",
        0x2a => "vi",
        _ => "en",
    }
}

#[cfg(windows)]
pub fn start_input_lang_watcher(app: AppHandle, paused_guard: Arc<AtomicBool>) {
    use std::sync::atomic::Ordering;
    use std::time::Duration;
    use tauri::Emitter;

    std::thread::spawn(move || {
        let own_pid = std::process::id();
        let mut announced = false;
        // Opt-in debug log (agent-debug.flag): one line per change of what the poll sees.
        let mut last_seen = String::new();
        loop {
            let paused = paused_guard.load(Ordering::Relaxed);
            if crate::ai_typing::debug_enabled() {
                let seen = if paused { "paused".to_string() } else { win_impl::describe_foreground(own_pid) };
                if seen != last_seen {
                    crate::ai_typing::debug_log("input.poll", &seen);
                    last_seen = seen;
                }
            }
            if !paused {
                if let Some(langid) = win_impl::foreground_langid(own_pid) {
                    let lang = code_for_langid(langid);
                    if store(&lang) || !announced {
                        crate::ai_typing::debug_log("input.lang", &format!("lang={lang} langid=0x{langid:04x}"));
                        announced = true;
                        let json = payload_json(&lang);
                        let _ = app.emit("kuro-input-lang", serde_json::json!({ "lang": lang }));
                        crate::obs::broadcast_raw("inputLang", &json);
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    });
}

#[cfg(not(windows))]
pub fn start_input_lang_watcher(_app: AppHandle, _paused_guard: Arc<AtomicBool>) {}

#[cfg(windows)]
mod win_impl {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetKeyboardLayout;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    #[link(name = "kernel32")]
    extern "system" {
        fn GetLocaleInfoW(locale: u32, lc_type: u32, data: *mut u16, len: i32) -> i32;
    }
    const LOCALE_SISO639LANGNAME: u32 = 0x59;

    /// LANGID of the foreground window's thread, or `None` when there is no foreground window
    /// or it belongs to KuroCat itself (then the caller keeps the last value).
    pub fn foreground_langid(own_pid: u32) -> Option<u16> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return None;
            }
            let mut pid: u32 = 0;
            let tid = GetWindowThreadProcessId(hwnd, &mut pid);
            if tid == 0 || pid == 0 || pid == own_pid {
                return None;
            }
            let hkl = GetKeyboardLayout(tid) as usize;
            let langid = (hkl & 0xffff) as u16;
            if langid == 0 {
                None
            } else {
                Some(langid)
            }
        }
    }

    /// Short description of what the poll sees, for the opt-in debug log: no foreground window,
    /// KuroCat itself in front (language kept), or the foreground window class + thread layout.
    pub fn describe_foreground(own_pid: u32) -> String {
        use windows_sys::Win32::UI::WindowsAndMessaging::GetClassNameW;
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return "no_foreground".into();
            }
            let mut pid: u32 = 0;
            let tid = GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == own_pid {
                return "own_window_keeps_last".into();
            }
            let mut buf = [0u16; 64];
            let n = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32).max(0) as usize;
            let class = String::from_utf16_lossy(&buf[..n]);
            let hkl = GetKeyboardLayout(tid) as usize;
            format!("class={class} thread_layout=0x{:04x}", hkl & 0xffff)
        }
    }

    pub fn iso639_for_lcid(lcid: u32) -> Option<String> {
        let mut buf = [0u16; 16];
        let n = unsafe {
            GetLocaleInfoW(lcid, LOCALE_SISO639LANGNAME, buf.as_mut_ptr(), buf.len() as i32)
        };
        if n <= 1 {
            return None;
        }
        let s = String::from_utf16_lossy(&buf[..(n as usize - 1)]).to_ascii_lowercase();
        if s.len() == 2 && s.bytes().all(|b| b.is_ascii_lowercase()) {
            Some(s)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thai_langid_is_th() {
        assert_eq!(code_for_langid(0x041e), "th");
    }

    #[test]
    fn common_langids_map_to_iso639() {
        assert_eq!(code_for_langid(0x0409), "en");
        assert_eq!(code_for_langid(0x0809), "en");
        assert_eq!(code_for_langid(0x0411), "ja");
        assert_eq!(code_for_langid(0x0804), "zh");
        assert_eq!(code_for_langid(0x0412), "ko");
    }

    #[test]
    fn payload_has_only_the_language() {
        assert_eq!(payload_json("th"), r#"{"lang":"th"}"#);
    }

    #[test]
    fn store_reports_changes_only() {
        // Single test touching CURRENT so parallel tests never race on it.
        assert!(store("xx"));
        assert!(!store("xx"));
        assert_eq!(current().as_deref(), Some("xx"));
        assert!(store("yy"));
    }
}
