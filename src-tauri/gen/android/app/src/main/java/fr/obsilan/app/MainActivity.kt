package fr.obsilan.app

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    demanderAccesFichiers()
  }

  /**
   * Les notes sont rangées dans Documents/ObsiLan pour rester de vrais fichiers,
   * visibles dans le gestionnaire de fichiers. Cela demande l'autorisation
   * « Accès à tous les fichiers » (Android 11+) ou l'écriture sur le stockage
   * (Android 10 et moins). On ne la demande qu'une seule fois : si l'utilisateur
   * refuse, l'application propose son stockage interne.
   */
  private fun demanderAccesFichiers() {
    val prefs = getSharedPreferences("obsilan", MODE_PRIVATE)
    if (prefs.getBoolean("acces_demande", false)) return
    prefs.edit().putBoolean("acces_demande", true).apply()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      if (Environment.isExternalStorageManager()) return
      try {
        startActivity(
          Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName"))
        )
      } catch (e: Exception) {
        startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
      }
    } else {
      requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), 1)
    }
  }
}
