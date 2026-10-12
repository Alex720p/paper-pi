import { setTimeout as delay } from "node:timers/promises";

export class InferenceUnavailableError extends Error {
	constructor() {
		super("Model endpoint unreachable in three consecutive probes; reconnect and resume the job.");
		this.name = "InferenceUnavailableError";
	}
}

export function isInferenceTransportError(error: unknown): boolean {
	const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
	return /fetch failed|connection error|network error|network connection|ECONN\w+|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|timed? ?out|\b50[234]\b/i.test(
		message,
	);
}

/** Non-generating reachability checks; HTTP auth/route errors still prove connectivity. */
export class InferenceMonitor {
	private readonly url: URL;
	private readonly onDisconnect: (error: InferenceUnavailableError) => void;
	private readonly intervalMs: number;
	private readonly timeoutMs: number;
	private readonly controller = new AbortController();
	private readonly signal: AbortSignal;
	private active = false;
	private generation = 0;
	private failures = 0;
	private disconnected = false;
	private watching: Promise<void> | undefined;

	constructor(
		baseUrl: string,
		onDisconnect: (error: InferenceUnavailableError) => void,
		options: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
	) {
		this.url = new URL(`${baseUrl.replace(/\/$/, "")}/models`);
		if (!["http:", "https:"].includes(this.url.protocol)) throw new Error("Model endpoint must use HTTP or HTTPS");
		this.onDisconnect = onDisconnect;
		this.intervalMs = options.intervalMs ?? 30_000;
		this.timeoutMs = options.timeoutMs ?? 20_000;
		this.signal = options.signal ? AbortSignal.any([this.controller.signal, options.signal]) : this.controller.signal;
	}

	setActive(active: boolean): void {
		if (active !== this.active) {
			this.active = active;
			this.generation++;
			this.failures = 0;
		}
	}

	/** Streaming data itself proves the inference connection is still alive. */
	reportActivity(): void {
		this.generation++;
		this.failures = 0;
	}

	private async reachable(): Promise<boolean> {
		try {
			const response = await fetch(this.url, {
				signal: AbortSignal.any([this.signal, AbortSignal.timeout(this.timeoutMs)]),
				redirect: "manual",
			});
			await response.body?.cancel();
			return ![502, 503, 504].includes(response.status);
		} catch {
			return false;
		}
	}

	private disconnect(): void {
		if (this.disconnected || this.signal.aborted) return;
		this.disconnected = true;
		this.onDisconnect(new InferenceUnavailableError());
	}

	/** Initial preflight and confirmation after an actual inference transport failure. */
	async confirmConnection(): Promise<void> {
		for (let attempt = 0; attempt < 3 && !this.signal.aborted; attempt++) {
			if (await this.reachable()) return;
			if (attempt < 2) {
				try {
					await delay(this.intervalMs, undefined, { signal: this.signal });
				} catch {
					return;
				}
			}
		}
		this.disconnect();
	}

	start(): void {
		this.watching ??= this.watch();
	}

	private async watch(): Promise<void> {
		while (!this.signal.aborted && !this.disconnected) {
			try {
				await delay(this.intervalMs, undefined, { signal: this.signal });
			} catch {
				return;
			}
			if (!this.active) continue;
			const generation = this.generation;
			const reachable = await this.reachable();
			// A probe that crossed a turn boundary must not count against another request.
			if (!this.active || generation !== this.generation) continue;
			this.failures = reachable ? 0 : this.failures + 1;
			if (this.failures >= 3) this.disconnect();
		}
	}

	async stop(): Promise<void> {
		this.controller.abort();
		await this.watching;
	}
}
