import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InferenceMonitor, InferenceUnavailableError, isInferenceTransportError } from "../src/inference-monitor.ts";

describe("inference connectivity", () => {
	afterEach(() => vi.unstubAllGlobals());

	it.each([200, 301, 401, 403, 404, 405, 429, 500])("accepts HTTP %i as evidence of reachability", async (status) => {
		const fetch = vi.fn().mockResolvedValue(new Response(null, { status }));
		vi.stubGlobal("fetch", fetch);
		const disconnected = vi.fn();
		const monitor = new InferenceMonitor("http://fixture.invalid/v1/", disconnected, { intervalMs: 1 });
		await monitor.confirmConnection();
		await monitor.stop();
		expect(disconnected).not.toHaveBeenCalled();
		expect(fetch.mock.calls[0]?.[0].toString()).toBe("http://fixture.invalid/v1/models");
	});

	it.each([502, 503, 504, "network"])("confirms three consecutive %s failures", async (status) => {
		const fetch =
			status === "network"
				? vi.fn().mockRejectedValue(new TypeError("fetch failed"))
				: vi.fn().mockImplementation(async () => new Response(null, { status: Number(status) }));
		vi.stubGlobal("fetch", fetch);
		const disconnected = vi.fn();
		const monitor = new InferenceMonitor("http://fixture.invalid", disconnected, { intervalMs: 1 });
		await monitor.confirmConnection();
		await monitor.stop();
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(disconnected).toHaveBeenCalledExactlyOnceWith(expect.any(InferenceUnavailableError));
	});

	it("resets failures on recovery and monitors only active inference", async () => {
		const responses = [503, 503, 200, 503, 503, 200, 503, 503, 503];
		const fetch = vi.fn().mockImplementation(async () => new Response(null, { status: responses.shift() ?? 200 }));
		vi.stubGlobal("fetch", fetch);
		const disconnected = vi.fn();
		const monitor = new InferenceMonitor("http://fixture.invalid", disconnected, { intervalMs: 1 });
		monitor.start();
		try {
			await delay(10);
			expect(fetch).not.toHaveBeenCalled();
			monitor.setActive(true);
			await vi.waitFor(() => expect(disconnected).toHaveBeenCalledTimes(1), { interval: 1 });
			expect(fetch).toHaveBeenCalledTimes(9);
		} finally {
			await monitor.stop();
		}
	});

	it("bounds a hanging probe and cancels promptly when the trial is aborted", async () => {
		const fetch = vi.fn().mockImplementation(
			(_url, options: RequestInit) =>
				new Promise((_, reject) => {
					options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		);
		vi.stubGlobal("fetch", fetch);
		const controller = new AbortController();
		const disconnected = vi.fn();
		const monitor = new InferenceMonitor("http://fixture.invalid", disconnected, {
			intervalMs: 1,
			timeoutMs: 5,
			signal: controller.signal,
		});
		const confirmation = monitor.confirmConnection();
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2), { interval: 1 });
		controller.abort();
		await confirmation;
		await monitor.stop();
		expect(disconnected).not.toHaveBeenCalled();
	});

	it("discards failures from a previous inference turn", async () => {
		let finish: ((response: Response) => void) | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(
				() =>
					new Promise<Response>((resolve) => {
						finish = resolve;
					}),
			),
		);
		const disconnected = vi.fn();
		const monitor = new InferenceMonitor("http://fixture.invalid", disconnected, { intervalMs: 1 });
		monitor.setActive(true);
		monitor.start();
		await vi.waitFor(() => expect(finish).toBeDefined(), { interval: 1 });
		monitor.setActive(false);
		finish?.(new Response(null, { status: 503 }));
		await delay(10);
		await monitor.stop();
		expect(disconnected).not.toHaveBeenCalled();
	});
	it("does not pause while real model activity proves the connection is alive", async () => {
		const disconnected = vi.fn();
		const monitor = new InferenceMonitor("http://fixture.invalid", disconnected, { intervalMs: 1 });
		const fetch = vi.fn().mockImplementation(async () => {
			monitor.reportActivity();
			return new Response(null, { status: 503 });
		});
		vi.stubGlobal("fetch", fetch);
		monitor.setActive(true);
		monitor.start();
		try {
			await vi.waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(3), { interval: 1 });
			expect(disconnected).not.toHaveBeenCalled();
		} finally {
			await monitor.stop();
		}
	});

	it("distinguishes transport failures from normal model and auth errors", () => {
		for (const message of ["Connection error.", "fetch failed", "ECONNRESET", "request timed out", "HTTP 503"]) {
			expect(isInferenceTransportError(new Error(message))).toBe(true);
		}
		for (const message of [
			"Invalid API key",
			"HTTP 401",
			"context length exceeded",
			"rate limit exceeded",
			"provider failed",
		]) {
			expect(isInferenceTransportError(new Error(message))).toBe(false);
		}
	});
});
