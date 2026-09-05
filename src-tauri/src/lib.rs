mod ai;
mod conversations;
mod errors;
mod files;
mod local_runtimes;
mod logging;
mod settings;
mod storage;
mod system_info;

use tauri::Manager;

#[tauri::command]
fn set_window_theme(window: tauri::WebviewWindow, dark: bool) -> Result<(), errors::BackendError> {
    window
        .set_theme(Some(if dark { tauri::Theme::Dark } else { tauri::Theme::Light }))
        .map_err(|error| errors::BackendError::runtime(error.to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            logging::setup(app.handle());
            app.manage(ai::RequestRegistry::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ai::get_ai_sources,
            ai::store_provider_credential,
            ai::clear_provider_credential,
            ai::discover_provider_models,
            ai::send_message,
            ai::stream_message,
            ai::cancel_message,
            set_window_theme,
            settings::load_settings,
            settings::save_settings,
            conversations::load_conversations,
            conversations::save_conversations,
            conversations::load_conversation_index,
            conversations::load_conversation,
            conversations::save_conversation_index,
            conversations::save_conversation,
            conversations::delete_conversation,
            conversations::clear_conversations,
            local_runtimes::get_local_runtimes,
            system_info::get_system_info,
            system_info::toggle_devtools,
            files::pick_folder,
            files::pick_file,
            files::validate_path,
            logging::get_logs,
            logging::clear_logs,
            logging::append_log,
            logging::append_logs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
