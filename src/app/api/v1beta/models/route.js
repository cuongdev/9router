import { buildModelsList, getDiscoveryAccessPolicy } from "../../v1/models/route.js";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * GET /v1beta/models - Gemini compatible models list
 * Returns models in Gemini API format
 */
export async function GET(request) {
  try {
    // Access-policy-filtered discovery list (combos + connected provider models).
    const visibleModels = await buildModelsList(["llm"], { accessPolicy: await getDiscoveryAccessPolicy(request) });
    const models = [];
    const seen = new Set();

    function addModel({ name, displayName, description, methods = ["generateContent"] }) {
      if (seen.has(name)) return;
      seen.add(name);
      models.push({
        name,
        displayName,
        description,
        supportedGenerationMethods: methods,
        inputTokenLimit: 128000,
        outputTokenLimit: 8192,
      });
    }

    for (const model of visibleModels) {
      addModel({
        name: `models/${model.id}`,
        displayName: model.id,
        description: `${model.owned_by || "provider"} model: ${model.id}`,
      });

      // Gemini native endpoint: also expose the bare model name + streaming method
      // so @google/genai SDK clients can call models/{id}:streamGenerateContent.
      if (model.owned_by === "gemini" && model.id.includes("/")) {
        const bareId = model.id.slice(model.id.indexOf("/") + 1);
        addModel({
          name: `models/${bareId}`,
          displayName: bareId,
          description: `Gemini model: ${bareId}`,
          methods: ["generateContent", "streamGenerateContent"],
        });
      }
    }

    return Response.json({ models });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json({ error: { message: error.message } }, { status: 500 });
  }
}
