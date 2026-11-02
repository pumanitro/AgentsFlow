package com.peersflow.mobile.glue

import android.app.Activity
import android.app.role.RoleManager
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.provider.Settings
import android.util.Log

const val REQUEST_ASSISTANT_ROLE = 71

fun Context.findActivity(): Activity? {
    var c: Context? = this
    while (c is ContextWrapper) {
        if (c is Activity) return c
        c = c.baseContext
    }
    return null
}

/** Asks to become the default digital assistant; falls back to the system voice-input settings page. */
fun requestAssistantRole(ctx: Context) {
    val activity = ctx.findActivity()
    val rm = ctx.getSystemService(RoleManager::class.java)
    if (activity != null && rm != null && rm.isRoleAvailable(RoleManager.ROLE_ASSISTANT)) {
        try {
            @Suppress("DEPRECATION")
            activity.startActivityForResult(rm.createRequestRoleIntent(RoleManager.ROLE_ASSISTANT), REQUEST_ASSISTANT_ROLE)
            return
        } catch (e: RuntimeException) {
            Log.w("PeersFlow", "role request failed (${e.javaClass.simpleName}); opening voice input settings")
        }
    }
    runCatching {
        val i = Intent(Settings.ACTION_VOICE_INPUT_SETTINGS)
        if (activity == null) i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        (activity ?: ctx).startActivity(i)
    }
}

fun isAssistantRoleHeld(ctx: Context): Boolean {
    val rm = ctx.getSystemService(RoleManager::class.java) ?: return false
    return runCatching { rm.isRoleAvailable(RoleManager.ROLE_ASSISTANT) && rm.isRoleHeld(RoleManager.ROLE_ASSISTANT) }
        .getOrDefault(false)
}
