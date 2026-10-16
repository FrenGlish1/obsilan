// Point d'entrée du .exe : masque la console Windows en version finale.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    obsilan_lib::run()
}
