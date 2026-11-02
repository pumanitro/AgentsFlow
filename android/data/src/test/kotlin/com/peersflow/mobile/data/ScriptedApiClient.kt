package com.peersflow.mobile.data

import com.peersflow.mobile.wire.AnswerRequest
import com.peersflow.mobile.wire.ApiClient
import com.peersflow.mobile.wire.ApiResult
import com.peersflow.mobile.wire.ReplyRequest
import com.peersflow.mobile.wire.ReplyResponse
import com.peersflow.mobile.wire.SpawnConversationRequest
import com.peersflow.mobile.wire.SpawnConversationResponse
import com.peersflow.mobile.wire.fakes.FakeApiClient

/**
 * Delegates to [FakeApiClient] but lets a test script the next answers of reply / answer / spawn, and records
 * every write call in order (successful or not) in [calls].
 */
class ScriptedApiClient(val base: FakeApiClient = FakeApiClient()) : ApiClient by base {
    val replyScript = ArrayDeque<ApiResult<ReplyResponse>>()
    val answerScript = ArrayDeque<ApiResult<ReplyResponse>>()
    val spawnScript = ArrayDeque<ApiResult<SpawnConversationResponse>>()

    /** ("reply" | "answer" | "spawn", clientId, text) in call order. */
    val calls = mutableListOf<Triple<String, String, String>>()
    val spawnRequests = mutableListOf<SpawnConversationRequest>()

    override suspend fun reply(id: String, req: ReplyRequest): ApiResult<ReplyResponse> {
        calls += Triple("reply", req.clientId, req.text)
        return replyScript.removeFirstOrNull() ?: ApiResult.Ok(ReplyResponse(ok = true, via = "open-chat"))
    }

    override suspend fun answer(id: String, req: AnswerRequest): ApiResult<ReplyResponse> {
        calls += Triple("answer", req.clientId, req.text)
        return answerScript.removeFirstOrNull() ?: ApiResult.Ok(ReplyResponse(ok = true, via = "open-chat"))
    }

    override suspend fun spawn(req: SpawnConversationRequest): ApiResult<SpawnConversationResponse> {
        calls += Triple("spawn", req.clientId, req.prompt)
        spawnRequests += req
        return spawnScript.removeFirstOrNull() ?: ApiResult.Ok(SpawnConversationResponse("new-${spawnRequests.size}"))
    }
}
