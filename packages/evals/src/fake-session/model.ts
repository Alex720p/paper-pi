import type { Api, FauxProviderHandle, Model } from "@earendil-works/pi-ai";
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const FAKE_PROVIDER_ID = "faux";
export const FAKE_MODEL_ID = "faux-1";

/**
 * Context window large enough that a driven session never crosses Pi's
 * auto-compaction threshold. Compaction would consume driver instructions,
 * so a fake session opts into it explicitly or not at all.
 */
const FAKE_CONTEXT_WINDOW = 1_000_000;
const FAKE_MAX_TOKENS = 65_536;

export interface FakeModelRuntime {
	modelRuntime: ModelRuntime;
	model: Model<Api>;
	faux: FauxProviderHandle;
}

/**
 * Isolated, network-free `ModelRuntime` whose only provider is the faux
 * provider from `@earendil-works/pi-ai`. Nothing here reads the user's agent
 * directory, `auth.json`, or `models.json`.
 */
export async function createFakeModelRuntime(): Promise<FakeModelRuntime> {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(FAKE_PROVIDER_ID, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });

	const faux = fauxProvider({
		provider: FAKE_PROVIDER_ID,
		models: [
			{
				id: FAKE_MODEL_ID,
				name: "Fake Session Model",
				input: ["text", "image"],
				contextWindow: FAKE_CONTEXT_WINDOW,
				maxTokens: FAKE_MAX_TOKENS,
			},
		],
	});
	modelRuntime.registerNativeProvider(faux.provider);
	// registerNativeProvider only fires its refresh with `void`, and prompt()
	// gates on hasConfiguredAuth(), so wait for the snapshot to settle.
	await modelRuntime.refresh({ allowNetwork: false });

	const model = modelRuntime.getModel(FAKE_PROVIDER_ID, FAKE_MODEL_ID);
	if (!model) throw new Error(`Fake session model not registered: ${FAKE_PROVIDER_ID}/${FAKE_MODEL_ID}`);
	if (
		!modelRuntime.hasConfiguredAuth(FAKE_PROVIDER_ID) &&
		(await modelRuntime.checkAuth(FAKE_PROVIDER_ID)) === undefined
	) {
		throw new Error(`Fake session provider reports no configured auth: ${FAKE_PROVIDER_ID}`);
	}

	return { modelRuntime, model, faux };
}
