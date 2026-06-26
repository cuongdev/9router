const UNRESTRICTED_POLICY = Object.freeze({ mode: "unrestricted" });

export class ApiKeyAccessDeniedError extends Error {
  constructor(message = "API key is not authorized for this model or account") {
    super(message);
    this.name = "ApiKeyAccessDeniedError";
    this.status = 403;
  }
}

function parsePolicy(policy) {
  if (!policy) return null;
  if (typeof policy === "string") {
    try { return JSON.parse(policy); } catch { return null; }
  }
  return policy;
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeModelIds(ids) {
  if (!Array.isArray(ids)) return [];
  return Array.from(new Set(ids.map(cleanString).filter(Boolean)));
}

function normalizeAccountGrant(grant) {
  const connectionId = cleanString(grant?.connectionId || grant?.id);
  if (!connectionId) return null;

  const rawModels = grant?.models && typeof grant.models === "object"
    ? grant.models
    : { mode: grant?.modelsMode, ids: grant?.modelIds };
  const mode = rawModels?.mode === "selected" || rawModels?.mode === "explicit" ? "selected" : "all";

  return {
    connectionId,
    models: mode === "selected"
      ? { mode: "selected", ids: normalizeModelIds(rawModels?.ids) }
      : { mode: "all", ids: [] },
  };
}

export function normalizeAccessPolicy(policy) {
  const parsed = parsePolicy(policy);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...UNRESTRICTED_POLICY };
  }

  const mode = parsed.mode === "restricted" ? "restricted" : "unrestricted";
  if (mode !== "restricted") return { ...UNRESTRICTED_POLICY };

  const grants = Array.isArray(parsed.accounts)
    ? parsed.accounts
    : (Array.isArray(parsed.connections) ? parsed.connections : []);

  const accounts = grants
    .map(normalizeAccountGrant)
    .filter(Boolean);

  return {
    mode: "restricted",
    accounts,
    combos: normalizeModelIds(parsed.combos || parsed.comboNames),
  };
}

export function serializeAccessPolicy(policy) {
  return JSON.stringify(normalizeAccessPolicy(policy));
}

export function validateAccessPolicy(policy) {
  const normalized = normalizeAccessPolicy(policy);
  if (normalized.mode !== "restricted") return normalized;

  for (const grant of normalized.accounts) {
    if (!grant.connectionId) throw new Error("Access policy account grant is missing connectionId");
    if (!["all", "selected"].includes(grant.models?.mode)) {
      throw new Error("Access policy account grant has invalid models mode");
    }
    if (grant.models.mode === "selected" && !Array.isArray(grant.models.ids)) {
      throw new Error("Access policy selected models must be an array");
    }
  }
  return normalized;
}

export function isUnrestricted(policy) {
  return normalizeAccessPolicy(policy).mode !== "restricted";
}

export function isComboAllowed(policy, comboName) {
  const normalized = normalizeAccessPolicy(policy);
  if (normalized.mode !== "restricted") return true;
  const name = cleanString(comboName);
  return !!name && normalized.combos.includes(name);
}

export function hasAssignedAccounts(policy) {
  const normalized = normalizeAccessPolicy(policy);
  return normalized.mode !== "restricted" || normalized.accounts.length > 0;
}

function modelCandidates(connection, model) {
  const raw = cleanString(model);
  if (!raw) return [];
  const provider = cleanString(connection?.provider);
  const candidates = new Set([raw]);
  if (raw.includes("/")) candidates.add(raw.slice(raw.indexOf("/") + 1));
  if (provider && !raw.includes("/")) candidates.add(`${provider}/${raw}`);
  const prefix = cleanString(connection?.providerSpecificData?.prefix);
  if (prefix && !raw.includes("/")) candidates.add(`${prefix}/${raw}`);
  return [...candidates];
}

export function connectionAllowsModel(policy, connection, model = null) {
  const normalized = normalizeAccessPolicy(policy);
  if (normalized.mode !== "restricted") return true;
  const connectionId = cleanString(connection?.id || connection?.connectionId);
  if (!connectionId) return false;

  const grant = normalized.accounts.find((item) => item.connectionId === connectionId);
  if (!grant) return false;
  if (grant.models?.mode !== "selected") return true;

  const ids = grant.models?.ids || [];
  if (!model) return false;
  const candidates = modelCandidates(connection, model);
  return candidates.some((candidate) => ids.includes(candidate));
}

export function filterAllowedConnections(policy, connections, model = null) {
  const list = Array.isArray(connections) ? connections : [];
  if (isUnrestricted(policy)) return list;
  return list.filter((connection) => connectionAllowsModel(policy, connection, model));
}

export function accountScopedAccessPolicy(policy) {
  const normalized = normalizeAccessPolicy(policy);
  if (normalized.mode !== "restricted") return normalized;
  return {
    ...normalized,
    accounts: normalized.accounts.map((grant) => ({
      ...grant,
      models: { mode: "all", ids: [] },
    })),
  };
}

export function assertUnrestrictedForVirtualAccess(policy, label = "public provider") {
  if (!isUnrestricted(policy)) {
    throw new ApiKeyAccessDeniedError(`API key is not authorized for ${label}`);
  }
}

export function canAccessProviderModel(policy, connections, provider, model = null) {
  const providerName = cleanString(provider);
  const providerConnections = (Array.isArray(connections) ? connections : [])
    .filter((conn) => {
      if (conn?.isActive === false) return false;
      if (!providerName) return true;
      return conn.provider === providerName || conn.providerSpecificData?.prefix === providerName;
    });
  return filterAllowedConnections(policy, providerConnections, model).length > 0;
}

export async function filterAllowedComboModels(policy, comboModels, resolveModelInfo, connections, options = {}) {
  const models = Array.isArray(comboModels) ? comboModels.filter((model) => typeof model === "string" && model.trim()) : [];
  if (isUnrestricted(policy)) return models;

  const defaultModel = cleanString(options.defaultModel);
  const routePolicy = options.accountScoped ? accountScopedAccessPolicy(policy) : policy;
  const allowed = [];
  for (const modelStr of models) {
    let info = null;
    try { info = await resolveModelInfo(modelStr); } catch { info = null; }
    if (info?.provider) {
      if (canAccessProviderModel(routePolicy, connections, info.provider, info.model || defaultModel || null)) allowed.push(modelStr);
      continue;
    }

    // Web search/fetch combos can store provider IDs or provider virtual model IDs.
    if (modelStr.includes("/")) {
      const slash = modelStr.indexOf("/");
      if (canAccessProviderModel(routePolicy, connections, modelStr.slice(0, slash), modelStr.slice(slash + 1) || defaultModel || null)) allowed.push(modelStr);
    } else if (canAccessProviderModel(routePolicy, connections, modelStr, defaultModel || null)) {
      allowed.push(modelStr);
    }
  }
  return allowed;
}

export async function comboUnderlyingModelsAllowed(policy, comboModels, resolveModelInfo, connections, options = {}) {
  const models = Array.isArray(comboModels) ? comboModels.filter((model) => typeof model === "string" && model.trim()) : [];
  const allowed = await filterAllowedComboModels(policy, models, resolveModelInfo, connections, options);
  return allowed.length === models.length;
}

export function accessDeniedResponse(error) {
  return Response.json(
    { error: { message: error?.message || "API key access denied", type: "access_denied" } },
    { status: 403, headers: { "Access-Control-Allow-Origin": "*" } }
  );
}
