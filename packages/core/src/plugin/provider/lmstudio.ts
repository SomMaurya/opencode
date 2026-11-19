import { Effect, Schema } from "effect"
import { createLocalProviderPlugin } from "./local.js"

const RemoteModel = Schema.Struct({
  type: Schema.String,
  key: Schema.String,
  display_name: Schema.String,
  architecture: Schema.NullOr(Schema.String).pipe(Schema.optional),
  loaded_instances: Schema.Array(
    Schema.Struct({
      config: Schema.Struct({ context_length: Schema.Int }),
    }),
  ),
  // Null for decision models whose context is unknown.
  max_context_length: Schema.NullOr(Schema.Int),
  capabilities: Schema.Struct({
    vision: Schema.Boolean,
    trained_for_tool_use: Schema.Boolean,
  }).pipe(Schema.optional),
  has_vision_adapter: Schema.Boolean.pipe(Schema.optional),
})

const Response = Schema.Struct({ models: Schema.Array(RemoteModel) })

type DiscoveredModel = typeof RemoteModel.Type & { context: number | null }

// LM Studio reports the context a model was loaded with only while an instance is loaded. It loads a model
// just in time with that saved configuration, so an unloaded model (for example after its idle TTL expired)
// must keep the context it was last loaded with instead of the architecture maximum, which LM Studio rejects.
const loadedContexts = new Map<string, Map<string, number>>()

export const make = createLocalProviderPlugin({
  id: "opencode.provider.lmstudio",
  providerID: "lmstudio",
  name: "LM Studio",
  origin: "http://127.0.0.1:1234",
  stripPathSuffix: /\/(?:api\/)?v1$/,
  discover: (client) =>
    Effect.gen(function* () {
      const response = yield* client.getJson("/api/v1/models", Response)
      const contexts = loadedContexts.get(client.root) ?? new Map<string, number>()
      loadedContexts.set(client.root, contexts)
      return response.models
        .filter((model) => (model.type === "llm" || model.type === "decision") && model.key.length > 0)
        .toSorted((a, b) => a.key.localeCompare(b.key))
        .map((item): DiscoveredModel => {
          const loaded =
            item.loaded_instances.length === 0
              ? undefined
              : Math.min(...item.loaded_instances.map((instance) => instance.config.context_length))
          if (loaded !== undefined) contexts.set(item.key, loaded)
          return { ...item, context: loaded ?? contexts.get(item.key) ?? item.max_context_length }
        })
    }),
  model: (item) => ({
    id: item.key,
    name: item.display_name || item.key,
    family: item.architecture,
    type: item.type === "decision" ? "decision" : "chat",
    tools: item.capabilities?.trained_for_tool_use,
    vision: item.capabilities?.vision ?? item.has_vision_adapter,
    context: item.context,
  }),
})

export const LMStudioPlugin = make()
