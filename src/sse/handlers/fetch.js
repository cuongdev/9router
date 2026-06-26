import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  getApiKeyContext,
} from "../services/auth.js";
import { getProviderConnections, getSettings, getCombos } from "@/lib/localDb";
import { AI_PROVIDERS, resolveProviderId } from "@/shared/constants/providers.js";
import { handleFetchCore } from "open-sse/handlers/fetch/index.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleComboChat, getComboModelsFromData } from "open-sse/services/combo.js";
import { assertPublicUrl } from "@/shared/utils/ssrfGuard.js";
import { ApiKeyAccessDeniedError, accessDeniedResponse, accountScopedAccessPolicy, filterAllowedComboModels, hasAssignedAccounts, isComboAllowed, isUnrestricted } from "@/lib/access/apiKeyAccessPolicy.js";
/**
 * Handle web fetch (URL extraction) request for the SSE/Next.js server.
 * Provider IS the model. Mirrors handleEmbeddings auth + fallback flow.
 *
 * @param {Request} request
 */
export async function handleFetch(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("FETCH", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const reqUrl = new URL(request.url);
  // Accept either `provider` or `model` (UI sends `model` since provider IS the model for webFetch)
  const providerInput = body.provider || body.model;
  const targetUrl = body.url;
  const format = body.format;
  const maxCharacters = body.max_characters;

  log.request("POST", `${reqUrl.pathname} | ${providerInput}`);

  // Log API key (masked)
  const apiKey = extractApiKey(request);
  if (apiKey) {
    log.debug("AUTH", `API Key: ${log.maskKey(apiKey)}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  let apiKeyContext = { rawKey: apiKey, apiKey: null, accessPolicy: null };
  if (apiKey) apiKeyContext = await getApiKeyContext(apiKey);
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    if (!apiKeyContext.apiKey) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!providerInput || typeof providerInput !== "string") {
    log.warn("FETCH", "Missing provider/model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: provider (or model)");
  }

  if (!targetUrl || typeof targetUrl !== "string") {
    log.warn("FETCH", "Missing url");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: url");
  }

  // Validate URL format
  try {
    new URL(targetUrl);
  } catch {
    log.warn("FETCH", "Invalid URL", { url: targetUrl });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid URL format");
  }

  // SSRF guard: reject internal/private/metadata targets
  try {
    assertPublicUrl(targetUrl);
  } catch (err) {
    log.warn("FETCH", "Blocked URL", { url: targetUrl });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, err.message);
  }

  // Combo expansion: providerInput may be a combo name → run fallback/round-robin across providers
  const combos = await getCombos();
  const comboModels = getComboModelsFromData(providerInput, combos);
  if (comboModels) {
    const comboAccess = await authorizeComboAccess(apiKeyContext.accessPolicy, providerInput, comboModels);
    if (comboAccess.response) return comboAccess.response;
    const allowedComboModels = comboAccess.models;
    const comboAccessPolicy = accountScopedAccessPolicy(apiKeyContext.accessPolicy);
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[providerInput]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("FETCH", `Combo "${providerInput}" with ${allowedComboModels.length}/${comboModels.length} providers (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: allowedComboModels,
      handleSingleModel: (b, m) => handleSingleProviderFetch(b, m, request, apiKey, settings, { ...apiKeyContext, accessPolicy: comboAccessPolicy }),
      log,
      comboName: providerInput,
      comboStrategy,
      comboStickyLimit
    });
  }

  return handleSingleProviderFetch(body, providerInput, request, apiKey, settings, apiKeyContext);
}

async function authorizeComboAccess(accessPolicy, comboName, comboModels) {
  if (!isComboAllowed(accessPolicy, comboName)) {
    return { response: accessDeniedResponse(new ApiKeyAccessDeniedError(`API key is not authorized for combo: ${comboName}`)), models: [] };
  }
  const connections = await getProviderConnections();
  const allowedModels = await filterAllowedComboModels(accessPolicy, comboModels, getModelInfo, connections, { defaultModel: "fetch", accountScoped: true });
  if (allowedModels.length === 0) {
    const message = hasAssignedAccounts(accessPolicy)
      ? `No allowed models for combo: ${comboName}`
      : `No accounts assigned for combo: ${comboName}`;
    return { response: accessDeniedResponse(new ApiKeyAccessDeniedError(message)), models: [] };
  }
  return { response: null, models: allowedModels };
}

async function handleSingleProviderFetch(body, providerInput, request, apiKey, settings, apiKeyContext) {
  const targetUrl = body.url;
  const format = body.format;
  const maxCharacters = body.max_characters;
  const providerId = resolveProviderId(providerInput);
  const resolvedProvider = AI_PROVIDERS[providerId];

  if (!resolvedProvider) {
    log.warn("FETCH", "Unknown provider", { provider: providerInput });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown provider: ${providerInput}`);
  }

  const providerConfig = resolvedProvider.fetchConfig;
  if (!providerConfig) {
    log.warn("FETCH", "Provider does not support web fetch", { provider: providerId });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Provider ${providerId} does not support web fetch`);
  }

  if (providerInput !== providerId) {
    log.info("ROUTING", `${providerInput} → ${providerId}`);
  } else {
    log.info("ROUTING", `Provider: ${providerId}`);
  }

  // No-auth fetch path (kept for parity though no current fetch provider sets noAuth)
  if (resolvedProvider.noAuth) {
    if (!isUnrestricted(apiKeyContext?.accessPolicy)) {
      return accessDeniedResponse(new ApiKeyAccessDeniedError(`API key is not authorized for provider: ${providerId}`));
    }
    log.info("AUTH", `\x1b[32m${providerId} no-auth mode\x1b[0m`);
    const result = await handleFetchCore({
      url: targetUrl,
      format,
      maxCharacters,
      provider: resolvedProvider.id,
      providerConfig,
      credentials: null,
      log
    });
    if (result.success) {
      return new Response(JSON.stringify(result.data), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Fetch failed");
  }

  // Credential + fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    let credentials;
    try {
      credentials = await getProviderCredentials(providerId, excludeConnectionIds, "fetch", { accessPolicy: apiKeyContext?.accessPolicy });
    } catch (error) {
      if (error instanceof ApiKeyAccessDeniedError) return accessDeniedResponse(error);
      throw error;
    }

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("FETCH", `[${providerId}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${providerId}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.error("AUTH", `No credentials for provider: ${providerId}`);
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${providerId}`);
      }
      log.warn("FETCH", "No more accounts available", { provider: providerId });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    log.info("AUTH", `\x1b[32mUsing ${providerId} account: ${credentials.connectionName}\x1b[0m`);

    const refreshedCredentials = await checkAndRefreshToken(providerId, credentials);

    const result = await handleFetchCore({
      url: targetUrl,
      format,
      maxCharacters,
      provider: resolvedProvider.id,
      providerConfig,
      credentials: refreshedCredentials,
      log,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials);
      }
    });

    if (result.success) {
      return new Response(JSON.stringify(result.data), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, providerId);

    if (shouldFallback) {
      log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Fetch failed");
  }
}
