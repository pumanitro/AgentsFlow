package com.peersflow.mobile.services

/** Set by AppGraph.init (from `PeersFlowApp.onCreate`) before any component of this module runs. */
object ServicesHost {
    lateinit var deps: ServicesDeps

    /** False only if a component somehow runs before the application object wired the graph. */
    val isReady: Boolean get() = ::deps.isInitialized
}
