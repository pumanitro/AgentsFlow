package com.peersflow.mobile.glue

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities

/**
 * True when the phone itself has a validated internet connection. This is NOT the Mac's state:
 * cloud speech must keep working while the Mac is off.
 */
fun internetReachable(ctx: Context): Boolean {
    val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return false
    val caps = runCatching { cm.getNetworkCapabilities(cm.activeNetwork) }.getOrNull() ?: return false
    return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
}
