import z from "@deepseek-ai/schemastery";
import { CallId, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, ProviderRequestId, ReasoningEffortId, RetryPolicySchema, contentHasImage, resolveRetryPolicy, userAgent } from "@deepseek-ai/dsh-llm";
import { deepEqualJson, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { request as request$1 } from "node:https";
import { connect } from "node:tls";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
//#region lib/types/eventstream.js
/**
* Incremental `vnd.amazon.eventstream` frame decoding. A frame is a 12-byte
* prelude (total length, header length, prelude CRC), the headers, the
* payload, and a trailing message CRC. Reads may split anywhere, so the
* decoder buffers until a frame is complete and yields whole frames only.
*
* CRCs are not verified: TLS already protects the transport, and a corrupt
* frame fails the JSON parse the caller performs on the payload.
*
* @module dsh-llm-kiro/eventstream
*/
/** Bytes before the headers: total length, header length, prelude CRC. */
const PRELUDE_BYTES = 12;
/** Bytes after the payload holding the message CRC. */
const MESSAGE_CRC_BYTES = 4;
/** Header value type tag for a UTF-8 string, the only type Kiro sends. */
const HEADER_TYPE_STRING = 7;
/**
* Largest frame this decoder will buffer. AWS caps event-stream messages at
* 16 MiB, so a larger declared length is a desynchronized stream rather than
* a big message, and refusing it bounds memory instead of buffering forever.
*/
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/**
* Decode one frame's headers.
* @param buffer - the whole buffered stream.
* @param start - offset of the first header byte.
* @param end - offset one past the last header byte.
* @returns the header name/value pairs.
* @throws `LlmError('MALFORMED_RESPONSE')` on a non-string header value type.
*/
function decodeHeaders(buffer, start, end) {
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	const decoder = new TextDecoder();
	const headers = {};
	let offset = start;
	while (offset < end) {
		const nameLength = view.getUint8(offset);
		offset += 1;
		const name = decoder.decode(buffer.subarray(offset, offset + nameLength));
		offset += nameLength;
		const type = view.getUint8(offset);
		offset += 1;
		if (type !== HEADER_TYPE_STRING) throw new LlmError(`Kiro event-stream header "${name}" has unsupported value type ${type}`, "MALFORMED_RESPONSE");
		const valueLength = view.getUint16(offset);
		offset += 2;
		headers[name] = decoder.decode(buffer.subarray(offset, offset + valueLength));
		offset += valueLength;
	}
	return headers;
}
/**
* Decode a byte stream into whole event-stream frames.
*
* A stream that ends mid-frame is truncation, not a flushable tail: the
* response cannot be trusted, so it raises rather than yielding a partial
* frame.
* @param stream - raw response bytes; reads may split anywhere, including
*   inside a prelude, header, or payload. Any async iterable of byte chunks
*   works, so the same decoder serves a `fetch` body and a Node response.
* @param onActivity - optional transport-activity callback invoked for each
*   read, so an idle watchdog can distinguish a slow model from a dead socket.
* @returns each complete frame in arrival order.
* @throws `LlmError('STREAM_CLOSED')` when the stream ends mid-frame, or
*   `LlmError('MALFORMED_RESPONSE')` on an implausible declared frame length.
*/
async function* decodeFrames(stream, onActivity) {
	let buffered = new Uint8Array(0);
	for await (const chunk of stream) {
		onActivity?.();
		const next = new Uint8Array(buffered.length + chunk.length);
		next.set(buffered);
		next.set(chunk, buffered.length);
		buffered = next;
		while (buffered.length >= PRELUDE_BYTES) {
			const view = new DataView(buffered.buffer, buffered.byteOffset, buffered.byteLength);
			const totalLength = view.getUint32(0);
			const headerLength = view.getUint32(4);
			if (totalLength > MAX_FRAME_BYTES || totalLength < PRELUDE_BYTES + headerLength + MESSAGE_CRC_BYTES) throw new LlmError(`Kiro event-stream frame declares an implausible length of ${totalLength} bytes`, "MALFORMED_RESPONSE");
			if (buffered.length < totalLength) break;
			const headerEnd = PRELUDE_BYTES + headerLength;
			yield {
				headers: decodeHeaders(buffered, PRELUDE_BYTES, headerEnd),
				payload: buffered.subarray(headerEnd, totalLength - MESSAGE_CRC_BYTES)
			};
			buffered = buffered.subarray(totalLength);
		}
	}
	if (buffered.length > 0) throw new LlmError(`Kiro event stream ended with ${buffered.length} bytes of an incomplete frame`, "STREAM_CLOSED");
}
//#endregion
//#region lib/types/serialize.js
/**
* Serialize harness messages into a Kiro `generateAssistantResponse` request.
*
* Three properties of the wire operation drive the whole translation:
*
* - There is no system slot. The system prompt is prepended to the content of
*   the first user turn, which is also where the thinking-mode markers go.
* - The last user turn is `currentMessage`, not a history entry, and
*   `conversationState.history` must strictly alternate user, assistant, user,
*   …, so gaps are filled with continuation placeholders.
* - Tool results are per-turn context on the user message that carries them,
*   and the service rejects a result whose `toolUseId` no history entry
*   issued, so unmatched results degrade to text.
*
* @module dsh-llm-kiro/serialize
*/
/** Request origin Kiro attributes IDE traffic to. */
const ORIGIN = "AI_EDITOR";
/** Text standing in for an absent turn, so history keeps alternating. */
const CONTINUATION = "[system: conversation continues]";
/** Content for a user turn that carries only tool results. */
const TOOL_RESULTS_ONLY = "Tool results provided.";
/** Tool names CodeWhisperer accepts verbatim. */
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** Maximum thinking length published for each effort, in tokens. */
const THINKING_BUDGETS = {
	low: 4e3,
	medium: 12e3,
	high: 24e3
};
/**
* Validate the adapter-owned effort.
* @param effort - the request's opaque effort identifier.
* @returns the same value, narrowed.
* @throws `LlmError('UNSUPPORTED_REASONING_EFFORT')` for any other value.
*/
function narrowEffort(effort) {
	if (effort === "off" || effort === "low" || effort === "medium" || effort === "high") return effort;
	throw new LlmError(`Kiro does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
}
/**
* Resolve the effort governing one request.
* @param options - the harness request.
* @param defaults - adapter-level defaults.
* @returns the effort, or `off` when thinking is not in play.
* @throws `LlmError('UNSUPPORTED_REASONING_EFFORT')` when a deployment that
*   disabled thinking is asked to enable it.
*/
function resolveEffort(options, defaults) {
	if (options.purpose === "session-title") return "off";
	const effort = options.reasoningEffort === void 0 ? defaults.reasoningEffort : narrowEffort(options.reasoningEffort);
	if (defaults.thinking === "disabled" && effort !== void 0 && effort !== "off") throw new LlmError(`Kiro deployment does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
	return effort ?? "off";
}
/**
* Build the system text Kiro sees, including thinking markers.
* @param options - the harness request.
* @param effort - the resolved effort.
* @returns the system text, empty when there is nothing to say.
*/
function systemText(options, effort) {
	const persona = options.system ?? "";
	if (effort === "off") return persona;
	const markers = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${THINKING_BUDGETS[effort]}</max_thinking_length>`;
	return persona.length === 0 ? markers : `${markers}\n${persona}`;
}
/** Join the text blocks of one message. */
function flattenText(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Reject image content before text flattening can silently erase it. */
function assertTextOnly(blocks) {
	if (contentHasImage(blocks)) throw new LlmError("The Kiro adapter does not support image content.", "UNSUPPORTED_CONTENT");
}
/**
* Validate one tool name against the wire pattern.
* @param name - the harness tool name.
* @returns the same name.
* @throws `LlmError('UNSUPPORTED_TOOL_NAME')` when Kiro would reject it.
*/
function assertToolName(name) {
	if (!TOOL_NAME_PATTERN.test(name)) throw new LlmError(`Kiro rejects tool name "${name}"; names must match ${String(TOOL_NAME_PATTERN)}`, "UNSUPPORTED_TOOL_NAME");
	return name;
}
/** Serialize the tool-result blocks of one message. */
function toolResultsOf(message) {
	return message.content.filter((block) => block.type === "tool-result").map((block) => ({
		toolUseId: block.toolCallId,
		content: [{ text: flattenText(block.content) || "(no output)" }],
		status: block.isError === true ? "error" : "success"
	}));
}
/** Serialize the tool-call blocks of one assistant message. */
function toolUsesOf(message) {
	return message.content.filter((block) => block.type === "tool-call").map((block) => ({
		toolUseId: block.id,
		name: assertToolName(block.name),
		input: parseArguments(block.arguments)
	}));
}
/**
* Parse tool-call arguments into the object Kiro expects.
* @param raw - the model's raw JSON argument string.
* @returns the parsed value, or an empty object when the model emitted
*   nothing or invalid JSON — replaying history must not fail a live request
*   over a malformed past call.
*/
function parseArguments(raw) {
	if (raw.length === 0) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}
/**
* Fold the harness conversation into alternating user and assistant turns.
* Consecutive same-role messages merge, because Kiro accepts only strict
* alternation.
* @param messages - the harness conversation, in order.
* @returns the folded turns, each tagged with its role.
*/
function foldTurns(messages) {
	const turns = [];
	for (const message of messages) {
		assertTextOnly(message.content);
		const text = flattenText(message.content);
		if (message.role === "assistant") {
			const toolUses = toolUsesOf(message);
			const last = turns.at(-1);
			if (last?.role === "assistant") {
				last.text = [last.text, text].filter((part) => part.length > 0).join("\n\n");
				last.toolUses = [...last.toolUses, ...toolUses];
				continue;
			}
			turns.push({
				role: "assistant",
				text,
				toolUses
			});
			continue;
		}
		const toolResults = toolResultsOf(message);
		const last = turns.at(-1);
		if (last?.role === "user") {
			last.turn.text = [last.turn.text, text].filter((part) => part.length > 0).join("\n\n");
			last.turn.toolResults = [...last.turn.toolResults, ...toolResults];
			continue;
		}
		turns.push({
			role: "user",
			turn: {
				text,
				toolResults
			}
		});
	}
	return turns;
}
/**
* Build one wire user message.
* @param turn - the folded user turn.
* @param model - the wire model id, repeated on every user turn.
* @param context - optional per-turn context (tools, tool results).
* @returns the wire message.
*/
function userMessage(turn, model, context) {
	return {
		content: turn.text.length > 0 ? turn.text : turn.toolResults.length > 0 ? TOOL_RESULTS_ONLY : CONTINUATION,
		modelId: model,
		origin: ORIGIN,
		...context === void 0 ? {} : { userInputMessageContext: context }
	};
}
/**
* Build the complete wire request.
*
* The final user turn becomes `currentMessage` and carries the tool schemas;
* everything before it becomes alternating history. A conversation whose last
* turn is the assistant's (a resumed session, a compaction boundary) gets a
* continuation user turn so there is something to answer.
* @param options - the harness request.
* @param defaults - adapter-level thinking defaults.
* @param conversationId - identifier for this request's conversation.
* @param profileArn - CodeWhisperer profile the account bills against.
* @returns the request body.
* @throws `LlmError` when the request carries images, an unusable tool name,
*   an unsupported effort, or no messages at all.
*/
function serializeRequest(options, defaults, conversationId, profileArn) {
	if (options.messages.length === 0) throw new LlmError("Kiro requires at least one message", "INVALID_REQUEST");
	const effort = resolveEffort(options, defaults);
	const turns = foldTurns(options.messages);
	if (turns.at(-1)?.role === "assistant") turns.push({
		role: "user",
		turn: {
			text: CONTINUATION,
			toolResults: []
		}
	});
	const current = turns.pop();
	/* v8 ignore next -- a non-empty conversation always folds to at least one turn */
	if (current === void 0 || current.role !== "user") throw new LlmError("Kiro request has no user turn to answer", "INVALID_REQUEST");
	const history = [];
	for (const entry of turns) {
		const expected = history.length % 2 === 0 ? "user" : "assistant";
		if (entry.role !== expected) history.push(expected === "user" ? { userInputMessage: userMessage({
			text: CONTINUATION,
			toolResults: []
		}, options.model) } : { assistantResponseMessage: { content: CONTINUATION } });
		if (entry.role === "user") {
			history.push({ userInputMessage: userMessage(entry.turn, options.model, entry.turn.toolResults.length > 0 ? { toolResults: entry.turn.toolResults } : void 0) });
			continue;
		}
		history.push({ assistantResponseMessage: {
			content: entry.text.length > 0 ? entry.text : CONTINUATION,
			...entry.toolUses.length > 0 ? { toolUses: entry.toolUses } : {}
		} });
	}
	if (history.length % 2 !== 0) history.push({ assistantResponseMessage: { content: CONTINUATION } });
	const issued = new Set(history.flatMap((entry) => "assistantResponseMessage" in entry ? (entry.assistantResponseMessage.toolUses ?? []).map((use) => use.toolUseId) : []));
	const matched = current.turn.toolResults.filter((result) => issued.has(result.toolUseId));
	const text = current.turn.toolResults.filter((result) => !issued.has(result.toolUseId)).reduce((accumulated, result) => `${accumulated}\n\n[Output for tool call ${result.toolUseId}]:\n${result.content[0]?.text ?? ""}`, current.turn.text);
	const tools = (options.tools ?? []).map((tool) => ({ toolSpecification: {
		name: assertToolName(tool.name),
		description: tool.description,
		inputSchema: { json: tool.parameters }
	} }));
	const system = systemText(options, effort);
	const currentMessage = userMessage({
		text,
		toolResults: matched
	}, options.model, tools.length > 0 || matched.length > 0 ? {
		...tools.length > 0 ? { tools } : {},
		...matched.length > 0 ? { toolResults: matched } : {}
	} : void 0);
	if (system.length > 0) {
		const first = history.find((entry) => "userInputMessage" in entry);
		if (first === void 0) currentMessage.content = `${system}\n\n${currentMessage.content}`;
		else first.userInputMessage.content = `${system}\n\n${first.userInputMessage.content}`;
	}
	return {
		...profileArn === void 0 ? {} : { profileArn },
		conversationState: {
			chatTriggerType: "MANUAL",
			conversationId,
			currentMessage: { userInputMessage: currentMessage },
			...history.length > 0 ? { history } : {}
		}
	};
}
//#endregion
//#region lib/types/transport.js
/**
* HTTPS transport with optional HTTP-proxy egress.
*
* `fetch` cannot be pointed at a proxy without a custom undici dispatcher, and
* this adapter needs one: Kiro authorizes Claude models by request egress, so
* the Claude routes are reachable only through a permitted exit. Node's
* `http`/`tls` modules already express that directly — a `CONNECT` tunnel with
* TLS negotiated inside it — so the proxy support costs no dependency, and
* proxy and direct requests differ only in how the socket is obtained.
*
* @module dsh-llm-kiro/transport
*/
/** Default port for each supported proxy scheme. */
const PROXY_PORTS = {
	"http:": 80,
	"https:": 443
};
/**
* Validate a proxy URL at its configuration boundary.
* @param raw - the configured proxy URL.
* @returns the parsed URL.
* @throws when the value is not a URL, or names a scheme this transport cannot open.
*/
function parseProxyUrl(raw) {
	let url;
	try {
		url = new URL(raw);
	} catch (error) {
		throw new Error(`llm-kiro: proxyUrl "${raw}" is not a valid URL`, { cause: error });
	}
	if (!(url.protocol in PROXY_PORTS)) throw new Error(`llm-kiro: proxyUrl scheme "${url.protocol}" is not supported; use http:// or https://`);
	if (url.hostname.length === 0) throw new Error(`llm-kiro: proxyUrl "${raw}" names no host`);
	return url;
}
/**
* Open a `CONNECT` tunnel to `host:port` through an HTTP proxy.
* @param proxy - the validated proxy URL.
* @param host - target hostname.
* @param port - target port.
* @param signal - caller cancellation.
* @returns the tunneled socket, ready for TLS.
* @throws `LlmError('TRANSPORT')` when the proxy refuses or the connection fails.
*/
function openTunnel(proxy, host, port, signal) {
	return new Promise((resolve, reject) => {
		const request$2 = (proxy.protocol === "https:" ? request$1 : request)({
			host: proxy.hostname,
			port: proxy.port.length > 0 ? Number(proxy.port) : PROXY_PORTS[proxy.protocol],
			method: "CONNECT",
			path: `${host}:${port}`,
			signal,
			headers: {
				host: `${host}:${port}`,
				...proxy.username.length > 0 ? { "proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}` } : {}
			}
		});
		request$2.once("connect", (response, socket) => {
			if (response.statusCode !== 200) {
				socket.destroy();
				reject(new LlmError(`Kiro proxy ${proxy.host} refused CONNECT with HTTP ${String(response.statusCode)}`, "TRANSPORT"));
				return;
			}
			resolve(socket);
		});
		request$2.once("error", (error) => {
			reject(new LlmError(`Kiro proxy ${proxy.host} connection failed`, "TRANSPORT", { cause: error }));
		});
		request$2.end();
	});
}
/**
* POST one request and resolve as soon as response headers arrive, so the
* caller streams the body itself.
* @param options - target, headers, body, cancellation, and optional proxy.
* @returns status, headers, and the body byte stream.
* @throws `LlmError('TRANSPORT')` on a pre-response transport failure, or
*   `LlmError('ABORTED')` when the caller cancelled first.
*/
async function post(options) {
	const target = new URL(options.url);
	const port = target.port.length > 0 ? Number(target.port) : 443;
	const tunnel = options.proxyUrl === void 0 ? void 0 : await openTunnel(parseProxyUrl(options.proxyUrl), target.hostname, port, options.signal);
	return new Promise((resolve, reject) => {
		const request = request$1({
			host: target.hostname,
			port,
			path: `${target.pathname}${target.search}`,
			method: "POST",
			signal: options.signal,
			...tunnel === void 0 ? {} : { createConnection: () => connect({
				socket: tunnel,
				servername: target.hostname
			}) },
			headers: {
				...options.headers,
				"content-length": String(Buffer.byteLength(options.body))
			}
		}, (response) => {
			resolve({
				status: response.statusCode ?? 0,
				headers: response.headers,
				body: response
			});
		});
		request.once("error", (error) => {
			tunnel?.destroy();
			if (options.signal.aborted) {
				reject(new LlmError("Kiro request aborted by caller", "ABORTED", { cause: error }));
				return;
			}
			reject(new LlmError(`Kiro request to ${target.host} failed`, "TRANSPORT", { cause: error }));
		});
		request.end(options.body);
	});
}
/**
* POST JSON and read the whole response, for the small non-streaming calls
* (token refresh) that share this transport's egress.
* @param url - absolute `https:` URL.
* @param body - value serialized as the JSON request body.
* @param proxyUrl - optional proxy egress.
* @param signal - caller cancellation.
* @returns the status and parsed JSON body; an unparsable body resolves as `undefined`.
*/
async function postJson(url, body, proxyUrl, signal) {
	const response = await post({
		url,
		headers: {
			"content-type": "application/json",
			accept: "application/json"
		},
		body: JSON.stringify(body),
		signal,
		...proxyUrl === void 0 ? {} : { proxyUrl }
	});
	const chunks = [];
	for await (const chunk of response.body) chunks.push(chunk);
	const text = Buffer.concat(chunks).toString("utf8");
	try {
		return {
			status: response.status,
			body: JSON.parse(text)
		};
	} catch {
		return {
			status: response.status,
			body: void 0
		};
	}
}
//#endregion
//#region lib/types/translate.js
/**
* Translate Kiro event-stream frames into the harness `StreamChunk` protocol.
*
* Kiro reports thinking inside the same text channel as visible output,
* delimited by `<thinking>` markers, and open-weight routes additionally leak
* a `<｜DSML｜` tool-call preamble into that channel. Both are filtered by a
* scanner that holds back only a tail short enough to be a partial marker, so
* markers split across frames are still recognized without delaying output.
*
* The stream carries no finish event and no token counts: the frame sequence
* simply ends. The terminal reason is therefore derived — `tool-calls` when
* the model opened any tool call, `stop` otherwise, and `EMPTY_RESPONSE` for a
* stream that produced no content at all.
*
* @module dsh-llm-kiro/translate
*/
/** Opens Kiro's in-band thinking channel. */
const THINKING_OPEN = "<thinking>";
/** Closes Kiro's in-band thinking channel. */
const THINKING_CLOSE = "</thinking>";
/**
* Tool-call preamble the open-weight routes leak into the text channel. It is
* an artifact of their prompt format, never content the user should read, and
* the real call always follows as a `toolUseEvent`.
*/
const DSML_MARKER = "<｜DSML｜";
/**
* Length of the longest suffix of `buffer` that is a proper prefix of any
* watched token. That tail must be held back: it may complete into a marker
* on the next frame.
* @param buffer - the unrouted text.
* @param tokens - markers being watched in the current channel.
* @returns the number of trailing characters to withhold.
*/
function heldSuffixLength(buffer, tokens) {
	const longest = Math.max(...tokens.map((token) => token.length));
	for (let length = Math.min(longest - 1, buffer.length); length > 0; length -= 1) {
		const suffix = buffer.slice(buffer.length - length);
		if (tokens.some((token) => token.startsWith(suffix))) return length;
	}
	return 0;
}
/**
* Routes Kiro's single text channel into harness text and reasoning runs.
*
* Marker recognition is stateful across frames, which is the point: a delta
* boundary inside `</thinking>` must not surface the tag as visible output.
*/
var TextRouter = class {
	channel = "text";
	buffer = "";
	/** Markers that end the current channel's run. */
	get watched() {
		switch (this.channel) {
			case "text": return [THINKING_OPEN, DSML_MARKER];
			case "reasoning": return [THINKING_CLOSE];
			case "suppressed": return [];
		}
	}
	/**
	* Route one text delta.
	* @param delta - text exactly as the frame carried it.
	* @returns the runs that can be emitted now, in order; a delta ending
	*   mid-marker contributes nothing until the marker resolves.
	*/
	push(delta) {
		if (this.channel === "suppressed") return [];
		this.buffer += delta;
		const routed = [];
		while (true) {
			const watched = this.watched;
			if (watched.length === 0) {
				this.buffer = "";
				return routed;
			}
			const hit = watched.map((token) => ({
				token,
				at: this.buffer.indexOf(token)
			})).filter((candidate) => candidate.at >= 0).sort((left, right) => left.at - right.at)[0];
			if (hit === void 0) break;
			const before = this.buffer.slice(0, hit.at);
			if (before.length > 0 && this.channel !== "suppressed") routed.push({
				channel: this.channel,
				text: before
			});
			this.buffer = this.buffer.slice(hit.at + hit.token.length);
			this.channel = hit.token === THINKING_OPEN ? "reasoning" : hit.token === THINKING_CLOSE ? "text" : "suppressed";
		}
		if (this.channel === "suppressed") return routed;
		const held = heldSuffixLength(this.buffer, this.watched);
		const emit = this.buffer.slice(0, this.buffer.length - held);
		this.buffer = this.buffer.slice(this.buffer.length - held);
		if (emit.length > 0) routed.push({
			channel: this.channel,
			text: emit
		});
		return routed;
	}
	/**
	* Release text withheld as a possible partial marker.
	* @returns the final run, or nothing when the buffer is empty or suppressed.
	*/
	flush() {
		if (this.channel === "suppressed" || this.buffer.length === 0) return [];
		const text = this.buffer;
		this.buffer = "";
		return [{
			channel: this.channel,
			text
		}];
	}
};
/** Assemble the final ContentBlock for one open block. */
function closeBlock(block) {
	switch (block.kind) {
		case "text": return {
			type: "text",
			text: block.text
		};
		case "reasoning": return {
			type: "reasoning",
			text: block.text
		};
		case "tool-call": return {
			type: "tool-call",
			id: CallId(block.callId ?? ""),
			name: block.name ?? "",
			arguments: block.text
		};
	}
}
/**
* Parse one frame payload as JSON.
* @param frame - the decoded frame.
* @returns the parsed event.
* @throws `LlmError('MALFORMED_RESPONSE')` when the payload is not JSON.
*/
function parsePayload(frame) {
	const text = new TextDecoder().decode(frame.payload);
	try {
		return JSON.parse(text);
	} catch {
		throw new LlmError(`malformed Kiro event payload: ${text.slice(0, 120)}`, "MALFORMED_RESPONSE");
	}
}
/**
* Translate decoded frames into harness chunks.
* @param frames - decoded event-stream frames in arrival order.
* @returns deltas as they arrive, then every `block-end`, then one terminal
*   `finish`. No `usage` chunk is emitted: the operation reports consumed
*   account credits rather than token counts.
* @throws `LlmError` for an in-band service exception frame or a malformed payload.
*/
async function* translate(frames) {
	const router = new TextRouter();
	const order = [];
	const toolBlocks = /* @__PURE__ */ new Map();
	let nextIndex = 0;
	let textBlock;
	let reasoningBlock;
	function open(kind) {
		const block = {
			index: nextIndex++,
			kind,
			text: ""
		};
		order.push(block);
		return block;
	}
	function* route(runs) {
		for (const run of runs) {
			if (run.channel === "reasoning") {
				if (reasoningBlock === void 0) {
					reasoningBlock = open("reasoning");
					yield {
						type: "block-start",
						index: reasoningBlock.index,
						blockType: "reasoning"
					};
				}
				reasoningBlock.text += run.text;
				yield {
					type: "reasoning-delta",
					index: reasoningBlock.index,
					text: run.text
				};
				continue;
			}
			if (textBlock === void 0) {
				textBlock = open("text");
				yield {
					type: "block-start",
					index: textBlock.index,
					blockType: "text"
				};
			}
			textBlock.text += run.text;
			yield {
				type: "text-delta",
				index: textBlock.index,
				text: run.text
			};
		}
	}
	for await (const frame of frames) {
		const exception = frame.headers[":exception-type"];
		if (exception !== void 0) throw new LlmError(`Kiro service exception ${exception}: ${new TextDecoder().decode(frame.payload).slice(0, 300)}`, exception);
		switch (frame.headers[":event-type"]) {
			case "assistantResponseEvent": {
				const event = parsePayload(frame);
				if (event.content.length > 0) yield* route(router.push(event.content));
				break;
			}
			case "toolUseEvent": {
				const event = parsePayload(frame);
				let block = toolBlocks.get(event.toolUseId);
				if (block === void 0) {
					block = open("tool-call");
					block.callId = event.toolUseId;
					toolBlocks.set(event.toolUseId, block);
					yield {
						type: "block-start",
						index: block.index,
						blockType: "tool-call"
					};
				}
				if (event.name !== void 0) block.name = event.name;
				const fragment = event.input ?? "";
				block.text += fragment;
				yield {
					type: "tool-call-delta",
					index: block.index,
					id: CallId(event.toolUseId),
					...block.name === void 0 ? {} : { name: block.name },
					argumentsDelta: fragment
				};
				break;
			}
			default: break;
		}
	}
	yield* route(router.flush());
	for (const block of order) yield {
		type: "block-end",
		index: block.index,
		block: closeBlock(block)
	};
	yield {
		type: "finish",
		reason: toolBlocks.size > 0 ? { kind: "tool-calls" } : order.length > 0 ? { kind: "stop" } : {
			kind: "error",
			failure: {
				message: "Kiro returned a completed response with no content",
				code: EMPTY_RESPONSE_CODE
			}
		}
	};
}
//#endregion
//#region lib/types/adapter.js
/**
* `KiroAdapter`: the Kiro `generateAssistantResponse` operation behind the
* harness LLM seam. The adapter is transport-only — connection facts arrive
* through a thunk resolved once per stream call and the bearer token through a
* per-request resolver — so the registering plugin owns validation, layering,
* and credential policy.
*
* @module dsh-llm-kiro/adapter
*/
var __addDisposableResource = function(env, value, async) {
	if (value !== null && value !== void 0) {
		if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
		var dispose, inner;
		if (async) {
			if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
			dispose = value[Symbol.asyncDispose];
		}
		if (dispose === void 0) {
			if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
			dispose = value[Symbol.dispose];
			if (async) inner = dispose;
		}
		if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
		if (inner) dispose = function() {
			try {
				inner.call(this);
			} catch (e) {
				return Promise.reject(e);
			}
		};
		env.stack.push({
			value,
			dispose,
			async
		});
	} else if (async) env.stack.push({ async: true });
	return value;
};
var __disposeResources = (function(SuppressedError) {
	return function(env) {
		function fail(e) {
			env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
			env.hasError = true;
		}
		var r, s = 0;
		function next() {
			while (r = env.stack.pop()) try {
				if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
				if (r.dispose) {
					var result = r.dispose.call(r.value);
					if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) {
						fail(e);
						return next();
					});
				} else s |= 1;
			} catch (e) {
				fail(e);
			}
			if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
			if (env.hasError) throw env.error;
		}
		return next();
	};
})(typeof SuppressedError === "function" ? SuppressedError : function(error, suppressed, message) {
	var e = new Error(message);
	return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
/** Default maximum idle interval while an outstanding provider read is pending. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
/** Default combined request/response context capacity for a Kiro model. */
const DEFAULT_CONTEXT_WINDOW = 2e5;
/** Timeout code distinguishing watchdog expiry from caller cancellation. */
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
/** User agent Kiro's own IDE sends; the service gates model access on it. */
const KIRO_USER_AGENT = "aws-sdk-js/3.738.0 KiroIDE";
const OFF = ReasoningEffortId("off");
const LOW = ReasoningEffortId("low");
const MEDIUM = ReasoningEffortId("medium");
const HIGH = ReasoningEffortId("high");
/** Efforts every thinking-capable Kiro model publishes, in display order. */
const REASONING_EFFORTS = [
	{
		id: OFF,
		name: "Off"
	},
	{
		id: LOW,
		name: "Low"
	},
	{
		id: MEDIUM,
		name: "Medium"
	},
	{
		id: HIGH,
		name: "High"
	}
];
/** The only effort a thinking-disabled deployment publishes. */
const OFF_ONLY_REASONING_EFFORTS = [{
	id: OFF,
	name: "Off"
}];
/** Describe one catalog entry for selector consumers. */
function modelInfo(provider, model) {
	return {
		provider,
		id: model.id,
		name: model.name ?? model.id,
		...model.description === void 0 ? {} : { description: model.description },
		inputModalities: ["text"]
	};
}
/**
* Map a Kiro HTTP status and error body to a stable harness code.
* @param status - status of a non-2xx response.
* @param body - the response body text, when available.
* @returns the normalized harness error code.
*/
function httpErrorCode(status, body) {
	if (status === 401) return "AUTH";
	if (status === 403) return body !== void 0 && body.includes("bearer token") ? "AUTH" : "FORBIDDEN";
	if (status === 429) return "RATE_LIMIT";
	if (status === 400) {
		if (body !== void 0 && body.includes("INVALID_MODEL_ID")) return "INVALID_MODEL";
		return "INVALID_REQUEST";
	}
	if (status >= 500) return "SERVER";
	return `HTTP_${status}`;
}
/**
* The Kiro adapter. One instance serves the whole route: the harness model
* name is the wire `modelId`, so adding a Kiro model is configuration rather
* than registration.
*/
var KiroAdapter = class extends LlmAdapter {
	config;
	constructor(config) {
		super();
		this.config = config;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "Kiro"
		};
	}
	providerRetryPolicy(_provider) {
		return this.config.options().retryPolicy;
	}
	listModels(provider) {
		return Promise.resolve(this.config.options().models.map((model) => modelInfo(provider, model)));
	}
	resolveModel(provider, model, _signal) {
		const connection = this.config.options();
		const configured = connection.models.find((entry) => entry.id === model);
		const thinking = connection.defaults.thinking !== "disabled" && (configured?.thinking ?? true);
		return Promise.resolve({
			...configured === void 0 ? {
				provider,
				id: model,
				name: model,
				inputModalities: ["text"]
			} : modelInfo(provider, configured),
			context: { contextWindow: configured?.contextWindow ?? connection.defaultContextWindow },
			reasoning: thinking ? {
				efforts: REASONING_EFFORTS,
				defaultEffort: ReasoningEffortId(connection.defaults.reasoningEffort ?? "off")
			} : {
				efforts: OFF_ONLY_REASONING_EFFORTS,
				defaultEffort: OFF
			}
		});
	}
	async *stream(options) {
		const env_1 = {
			stack: [],
			error: void 0,
			hasError: false
		};
		try {
			const connection = this.config.options();
			const consumer = new AbortController();
			const watchdog = __addDisposableResource(env_1, idleWatchdog(options.signal === void 0 ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]), connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE), false);
			const iterator = this.request(options, watchdog.signal, connection, () => {
				watchdog.pulse();
			})[Symbol.asyncIterator]();
			let exhausted = false;
			try {
				while (true) {
					const result = await watchdog.next(iterator);
					if (result.done) {
						exhausted = true;
						return;
					}
					yield result.value;
				}
			} catch (error) {
				if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== void 0) throw new LlmError(`Kiro stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
				if (options.signal?.aborted) throw new LlmError("Kiro request aborted by caller", "ABORTED", { cause: error });
				if (error instanceof LlmError) throw error;
				throw new LlmError("Kiro API stream failed", "TRANSPORT", { cause: error });
			} finally {
				consumer.abort("Kiro stream consumer stopped");
				if (!exhausted && iterator.return !== void 0) try {
					await iterator.return();
				} catch (_abortedTransportTeardown) {}
			}
		} catch (e_1) {
			env_1.error = e_1;
			env_1.hasError = true;
		} finally {
			__disposeResources(env_1);
		}
	}
	async *request(options, signal, connection, onActivity) {
		const token = await this.config.resolveToken(connection, signal);
		const region = connection.region ?? token.region;
		const body = JSON.stringify(serializeRequest(options, connection.defaults, randomUUID(), connection.profileArn));
		const response = await post({
			url: `https://q.${region}.amazonaws.com/generateAssistantResponse`,
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token.accessToken}`,
				"x-amzn-kiro-agent-mode": "vibe",
				"user-agent": KIRO_USER_AGENT,
				"x-amz-user-agent": `${KIRO_USER_AGENT} ${userAgent()}`
			},
			body,
			signal,
			...connection.proxyUrl === void 0 ? {} : { proxyUrl: connection.proxyUrl }
		});
		if (response.status !== 200) {
			const chunks = [];
			for await (const chunk of response.body) chunks.push(chunk);
			const text = Buffer.concat(chunks).toString("utf8");
			let message = `Kiro API error (HTTP ${response.status})`;
			try {
				const parsed = JSON.parse(text);
				if (parsed.message !== void 0) message = parsed.message;
			} catch {}
			const id = response.headers["x-amzn-requestid"];
			throw new LlmError(message, httpErrorCode(response.status, text), {
				status: response.status,
				...typeof id === "string" && id.length > 0 ? { requestId: ProviderRequestId(id) } : {}
			});
		}
		yield* translate(decodeFrames(response.body, onActivity));
	}
};
//#endregion
//#region lib/types/auth.js
/**
* Resolve a usable Kiro bearer token from the credentials Kiro itself stores.
*
* Kiro's IDE sign-in writes `~/.aws/sso/cache/kiro-auth-token.json` (the
* access and refresh tokens) plus a sibling `<clientIdHash>.json` (the OIDC
* device-registration client id and secret). The two files are one credential:
* refreshing requires the client pair that issued the refresh token, so a
* token file naming a registration that is absent cannot be refreshed.
*
* Refreshed access tokens are cached in memory only. Kiro owns those files and
* writes them from its own sign-in and refresh; writing back would race a
* process this adapter does not coordinate with, and the refresh endpoint
* returns the same refresh token rather than rotating it, so a fresh access
* token is derivable at any time.
*
* @module dsh-llm-kiro/auth
*/
/** Directory holding Kiro's SSO token and device-registration files. */
const SSO_CACHE_DIR = [
	".aws",
	"sso",
	"cache"
];
/** File Kiro writes its access and refresh tokens to. */
const TOKEN_FILE = "kiro-auth-token.json";
/** Region used when the token file names none. */
const DEFAULT_REGION = "us-east-1";
/**
* Read and parse one JSON file from the SSO cache.
* @param path - absolute file path.
* @param what - human name used in the failure message.
* @returns the parsed contents.
* @throws `LlmError('MISSING_CREDENTIAL')` when absent, `LlmError('INVALID_CREDENTIAL')` when unparsable.
*/
async function readJsonFile(path, what) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") throw new LlmError(`Kiro ${what} not found at ${path}; sign in with the Kiro IDE or kiro-cli first`, "MISSING_CREDENTIAL", { cause: error });
		throw new LlmError(`Kiro ${what} at ${path} could not be read`, "INVALID_CREDENTIAL", { cause: error });
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new LlmError(`Kiro ${what} at ${path} is not valid JSON`, "INVALID_CREDENTIAL", { cause: error });
	}
}
/** Last refreshed token, reused until it approaches expiry. */
let cached;
/** Discard the cached access token; tests and credential rotation start clean. */
function clearTokenCache() {
	cached = void 0;
}
/**
* Exchange the stored refresh token for a fresh access token.
* @param refreshToken - the stored refresh token.
* @param registration - the client pair that issued it.
* @param region - OIDC region.
* @param options - transport and clock configuration.
* @returns the fresh token.
* @throws `LlmError('AUTH')` when the endpoint refuses the grant.
*/
async function refresh(refreshToken, registration, region, options) {
	if (registration.clientId === void 0 || registration.clientSecret === void 0) throw new LlmError("Kiro device registration is missing its client id or secret; sign in again", "INVALID_CREDENTIAL");
	const { status, body } = await options.fetchJson(`https://oidc.${region}.amazonaws.com/token`, {
		refreshToken,
		clientId: registration.clientId,
		clientSecret: registration.clientSecret,
		grantType: "refresh_token"
	});
	if (status !== 200) throw new LlmError(`Kiro token refresh failed: ${typeof body === "object" && body !== null && "error_description" in body ? String(body.error_description) : `HTTP ${status}`}`, "AUTH", { status });
	const parsed = body;
	const accessToken = parsed.accessToken ?? parsed.access_token;
	if (accessToken === void 0 || accessToken.length === 0) throw new LlmError("Kiro token refresh returned no access token", "AUTH", { status });
	const lifetimeSeconds = parsed.expiresIn ?? parsed.expires_in ?? 3600;
	return {
		accessToken,
		region,
		expiresAt: Date.now() + lifetimeSeconds * 1e3
	};
}
/**
* Resolve a bearer token that is valid now.
*
* The in-memory token is preferred, then the token Kiro has on disk, and only
* a request that finds neither usable spends an OIDC refresh — so a session
* running beside the Kiro IDE normally reuses the IDE's own fresh token.
* @param options - file location, expiry buffer, and refresh transport.
* @returns a token whose remaining lifetime exceeds the configured buffer.
* @throws `LlmError` with `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`, or `AUTH`.
*/
async function resolveToken(options) {
	const now = Date.now();
	if (cached !== void 0 && now < cached.expiresAt - options.expiryBufferMs) return cached;
	const directory = options.cacheDir ?? join(homedir(), ...SSO_CACHE_DIR);
	const token = await readJsonFile(join(directory, TOKEN_FILE), "token file");
	const region = token.region ?? DEFAULT_REGION;
	const fileExpiry = token.expiresAt === void 0 ? 0 : Date.parse(token.expiresAt);
	if (token.accessToken !== void 0 && Number.isFinite(fileExpiry) && now < fileExpiry - options.expiryBufferMs) return {
		accessToken: token.accessToken,
		region,
		expiresAt: fileExpiry
	};
	if (token.refreshToken === void 0 || token.clientIdHash === void 0) throw new LlmError("Kiro token file has expired and carries no refresh token or client registration; sign in again", "INVALID_CREDENTIAL");
	const registration = await readJsonFile(join(directory, `${token.clientIdHash}.json`), "device registration");
	cached = await refresh(token.refreshToken, registration, region, options);
	return cached;
}
//#endregion
//#region lib/types/index.js
/**
* Register a {@link KiroAdapter} for the `kiro` provider route on `ctx.llm`,
* with connection facts resolved per request instead of frozen at load: the
* plugin layers its `cordis.yml` entry config under the optional `llm-kiro`
* user-settings section (`ctx.settings`), so a changed proxy, profile, or
* catalog reaches the very next request without restarting anything, while an
* in-flight stream keeps the facts it started with. The one
* registration-captured fact — the retry policy — re-registers the route in
* place when it changes.
*
* Credentials are not configured here. Kiro's own IDE or CLI sign-in owns the
* token files under `~/.aws/sso/cache`, and this plugin reads and refreshes
* them rather than introducing a second place to store the same secret.
*
* @module @deepseek-ai/dsh-llm-kiro
*/
const name = "llm-kiro";
const inject = ["llm"];
const NS = settingsNamespace("llm-kiro");
/** The single provider route this plugin owns. */
const PROVIDER = "kiro";
/** Refresh a token this long before its actual expiry. */
const DEFAULT_TOKEN_EXPIRY_BUFFER_MS = 3e5;
/** Long-context Claude variants Kiro publishes with a 1M window. */
const CONTEXT_1M = 1e6;
/**
* Models this account tier reaches, verified against the live service. Claude
* entries need authorized egress; the open-weight entries answer from any.
*/
const DEFAULT_MODELS = [
	{
		id: "auto",
		name: "Auto",
		thinking: false
	},
	{
		id: "claude-sonnet-4.5",
		name: "Claude Sonnet 4.5",
		thinking: true
	},
	{
		id: "claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		contextWindow: CONTEXT_1M,
		thinking: true
	},
	{
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		contextWindow: CONTEXT_1M,
		thinking: true
	},
	{
		id: "claude-opus-4.5",
		name: "Claude Opus 4.5",
		thinking: true
	},
	{
		id: "claude-opus-5",
		name: "Claude Opus 5",
		contextWindow: CONTEXT_1M,
		thinking: true
	},
	{
		id: "claude-haiku-4.5",
		name: "Claude Haiku 4.5",
		thinking: false
	},
	{
		id: "deepseek-3.2",
		name: "DeepSeek 3.2",
		thinking: true
	},
	{
		id: "glm-5",
		name: "GLM-5",
		thinking: true
	},
	{
		id: "minimax-m2.5",
		name: "MiniMax M2.5",
		thinking: true
	},
	{
		id: "qwen3-coder-next",
		name: "Qwen3 Coder Next",
		thinking: false
	}
];
const catalogModel = z.object({
	id: z.string().required(),
	name: z.string(),
	description: z.string(),
	contextWindow: z.number().step(1).min(1),
	thinking: z.boolean()
});
const Config = z.object({
	proxyUrl: z.string(),
	region: z.string(),
	profileArn: z.string(),
	thinking: z.union(["enabled", "disabled"]),
	reasoningEffort: z.union([
		"off",
		"low",
		"medium",
		"high"
	]),
	defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
	models: z.array(catalogModel).default(DEFAULT_MODELS),
	streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
	tokenExpiryBufferMs: z.number().min(0).max(MAX_TIMER_DELAY_MS).default(DEFAULT_TOKEN_EXPIRY_BUFFER_MS),
	retryPolicy: RetryPolicySchema
});
/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models) {
	const seen = /* @__PURE__ */ new Set();
	return (models ?? DEFAULT_MODELS).map((model) => {
		if (model.id.length === 0) throw new Error("llm-kiro: catalog model ids must be non-empty");
		if (model.name !== void 0 && model.name.length === 0) throw new Error(`llm-kiro: catalog model "${model.id}" has an empty name`);
		if (model.contextWindow !== void 0 && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) throw new Error(`llm-kiro: catalog model "${model.id}" contextWindow must be a positive integer`);
		if (seen.has(model.id)) throw new Error(`llm-kiro: duplicate catalog model "${model.id}"`);
		seen.add(model.id);
		return {
			id: model.id,
			...model.name === void 0 ? {} : { name: model.name },
			...model.description === void 0 ? {} : { description: model.description },
			...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
			...model.thinking === void 0 ? {} : { thinking: model.thinking }
		};
	});
}
/**
* The one explicit resolve step from raw config to validated connection facts.
* Programmatic construction may bypass Schemastery normalization, so every
* default and bound is re-judged here — for the composition entry at load
* (fail loud) and for each settings snapshot at its first use.
* @param config - raw plugin config or resolved settings snapshot.
* @returns validated connection facts.
* @throws when a field is present but unusable (a malformed proxy URL, a
*   duplicate catalog id, an out-of-range timeout).
*/
function resolveAdapterOptions(config) {
	if (config.thinking === "disabled" && config.reasoningEffort !== void 0 && config.reasoningEffort !== "off") throw new Error("llm-kiro: only reasoningEffort \"off\" can be configured when thinking is disabled");
	if (config.proxyUrl !== void 0) parseProxyUrl(config.proxyUrl);
	if (config.defaultContextWindow !== void 0 && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) throw new Error("llm-kiro: defaultContextWindow must be a positive integer");
	const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 3e5;
	if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`llm-kiro: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	const tokenExpiryBufferMs = config.tokenExpiryBufferMs ?? DEFAULT_TOKEN_EXPIRY_BUFFER_MS;
	if (!Number.isFinite(tokenExpiryBufferMs) || tokenExpiryBufferMs < 0 || tokenExpiryBufferMs > MAX_TIMER_DELAY_MS) throw new Error(`llm-kiro: tokenExpiryBufferMs must be a non-negative finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	return {
		...config.proxyUrl === void 0 ? {} : { proxyUrl: config.proxyUrl },
		...config.region === void 0 ? {} : { region: config.region },
		...config.profileArn === void 0 ? {} : { profileArn: config.profileArn },
		defaults: {
			thinking: config.thinking,
			reasoningEffort: config.reasoningEffort
		},
		defaultContextWindow: config.defaultContextWindow ?? 2e5,
		models: resolveModels(config.models),
		streamIdleTimeoutMs,
		tokenExpiryBufferMs,
		retryPolicy: resolveRetryPolicy(config.retryPolicy, "llm-kiro: retryPolicy")
	};
}
function apply(ctx, config) {
	let current = () => config;
	let lastRaw;
	let lastGood;
	const options = () => {
		const raw = current();
		if (raw === lastRaw && lastGood !== void 0) return lastGood;
		try {
			const next = resolveAdapterOptions(raw);
			lastRaw = raw;
			lastGood = next;
			return next;
		} catch (error) {
			if (lastGood === void 0) throw error;
			lastRaw = raw;
			ctx.logger.error("llm-kiro: keeping the last good configuration after an invalid settings section");
			ctx.logger.error(error);
			return lastGood;
		}
	};
	options();
	const adapter = new KiroAdapter({
		options,
		resolveToken: (connection, signal) => resolveToken({
			expiryBufferMs: connection.tokenExpiryBufferMs,
			fetchJson: (url, body) => postJson(url, body, connection.proxyUrl, signal)
		})
	});
	ctx.llm.registerConfigurableProviders([{
		provider: PROVIDER,
		displayName: "Kiro",
		settingsNs: NS,
		settingsPath: []
	}]);
	const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
	let registeredPolicy = options().retryPolicy;
	const ensureRegistrationFacts = () => {
		const policy = options().retryPolicy;
		if (deepEqualJson(policy, registeredPolicy)) return;
		registration.replace([PROVIDER]);
		registeredPolicy = policy;
	};
	installSettingsSection(ctx, NS, Config, config, {
		setSource: (source) => {
			current = source;
		},
		onChange: ensureRegistrationFacts
	});
}
//#endregion
export { Config, DEFAULT_CONTEXT_WINDOW, DEFAULT_STREAM_IDLE_TIMEOUT_MS, KiroAdapter, apply, clearTokenCache, httpErrorCode, inject, name, resolveAdapterOptions, resolveToken };
