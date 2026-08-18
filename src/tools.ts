import type { Tool } from "@modelcontextprotocol/server";

import { requestWowAudit, type HttpMethod } from "./client.js";
import { getConfig, getFeatureFlags } from "./config.js";
import {
  compactObject,
  optionalDate,
  optionalBoolean,
  optionalEnum,
  optionalIntegerArray,
  optionalObjectArray,
  optionalPositiveInteger,
  optionalString,
  requireConfirmation,
  requireDate,
  requirePositiveInteger,
  requireString,
  requireTime,
  type Args,
} from "./validation.js";

const ROLES = ["Melee", "Ranged", "Heal", "Tank"] as const;
const RANKS = ["Main", "Trial", "Social", "Alt"] as const;
const DIFFICULTIES = ["Mythic", "Heroic", "Normal", "Raid Finder"] as const;
const RAID_STATUSES = ["Planned", "Locked", "Cancelled"] as const;
const SIGNUP_STATUSES = [
  "Present",
  "Absent",
  "Tentative",
  "Late",
  "Standby",
] as const;
const CLASSES = [
  "Warrior",
  "Paladin",
  "Hunter",
  "Rogue",
  "Priest",
  "Death Knight",
  "Shaman",
  "Mage",
  "Warlock",
  "Monk",
  "Druid",
  "Demon Hunter",
  "Evoker",
] as const;
const APPLICATION_STATUSES = ["under_review", "accepted", "rejected"] as const;
const RAIDLENS_WRITE_TOOLS = new Set([
  "wowaudit_track_character",
  "wowaudit_update_character",
  "wowaudit_create_raid",
  "wowaudit_update_raid",
  "wowaudit_upload_wishlist",
]);

const EMPTY_INPUT = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const LIMIT_PROPERTY = {
  type: "integer",
  minimum: 1,
  maximum: 500,
  description:
    "Maximum top-level collection entries returned after WoWAudit responds. The upstream API does not document pagination.",
} as const;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    data: {},
    meta: {
      type: "object",
      properties: {
        endpoint: { type: "string" },
        method: { type: "string" },
        totalItems: { type: "integer" },
        returnedItems: { type: "integer" },
        truncated: { type: "boolean" },
      },
      required: ["endpoint", "method"],
      additionalProperties: false,
    },
  },
  required: ["data", "meta"],
  additionalProperties: false,
} as const;

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const UPDATE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const DELETE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

interface ToolResultData {
  data: unknown;
  meta: {
    endpoint: string;
    method: HttpMethod;
    totalItems?: number;
    returnedItems?: number;
    truncated?: boolean;
  };
}

export interface ToolDescriptor {
  definition: Tool;
  execute(args: Args): Promise<Record<string, unknown>>;
}

function defineTool(
  name: string,
  description: string,
  inputSchema: Tool["inputSchema"],
  annotations: Tool["annotations"],
  execute: ToolDescriptor["execute"],
): ToolDescriptor {
  return {
    definition: {
      name,
      description,
      inputSchema,
      outputSchema: OUTPUT_SCHEMA,
      annotations,
    },
    execute,
  };
}

async function call(
  endpoint: string,
  options: {
    method?: HttpMethod;
    query?: Record<string, string | number | boolean | undefined>;
    body?: Record<string, unknown>;
    limit?: number;
    collectionKey?: string;
  } = {},
): Promise<Record<string, unknown>> {
  const method = options.method ?? "GET";
  const raw = await requestWowAudit(endpoint, {
    method,
    query: options.query,
    body: options.body,
  });
  return shapeResult(
    raw,
    endpoint,
    method,
    options.limit,
    options.collectionKey,
  ) as unknown as Record<string, unknown>;
}

function shapeResult(
  raw: unknown,
  endpoint: string,
  method: HttpMethod,
  limit?: number,
  collectionKey?: string,
): ToolResultData {
  const meta: ToolResultData["meta"] = { endpoint, method };
  if (!limit) return { data: raw, meta };

  if (Array.isArray(raw)) {
    const data = raw.slice(0, limit);
    return {
      data,
      meta: {
        ...meta,
        totalItems: raw.length,
        returnedItems: data.length,
        truncated: data.length < raw.length,
      },
    };
  }

  if (collectionKey && isRecord(raw) && Array.isArray(raw[collectionKey])) {
    const collection = raw[collectionKey] as unknown[];
    const limited = collection.slice(0, limit);
    return {
      data: { ...raw, [collectionKey]: limited },
      meta: {
        ...meta,
        totalItems: collection.length,
        returnedItems: limited.length,
        truncated: limited.length < collection.length,
      },
    };
  }

  return { data: raw, meta };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function idInput(
  description: string,
  extra: Record<string, unknown> = {},
): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1, description },
      ...extra,
    },
    required: ["id"],
    additionalProperties: false,
  } as Tool["inputSchema"];
}

function destructiveIdInput(description: string): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1, description },
      confirm: {
        type: "boolean",
        const: true,
        description: "Explicit confirmation of this destructive action.",
      },
    },
    required: ["id", "confirm"],
    additionalProperties: false,
  };
}

function mutationInput(
  properties: Record<string, unknown>,
  required: string[] = [],
): Tool["inputSchema"] {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  } as Tool["inputSchema"];
}

export const TOOL_DESCRIPTORS: ToolDescriptor[] = [
  defineTool(
    "wowaudit_get_team",
    "Get the authenticated WoWAudit team, guild identity, refresh timestamps, raid-day schedule, and wishlist freshness.",
    EMPTY_INPUT,
    READ_ANNOTATIONS,
    async () => call("/v1/team"),
  ),
  defineTool(
    "wowaudit_get_period",
    "Get the current Blizzard keystone period and WoWAudit season identifiers used by historical and loot tools.",
    EMPTY_INPUT,
    READ_ANNOTATIONS,
    async () => call("/v1/period"),
  ),
  defineTool(
    "wowaudit_list_characters",
    "List tracked roster characters with realm, class, role, rank, tracking status, note, and WoWAudit identifiers.",
    mutationInput({ limit: LIMIT_PROPERTY }),
    READ_ANNOTATIONS,
    async (args) =>
      call("/v1/characters", {
        limit: optionalPositiveInteger(args, "limit"),
      }),
  ),
  defineTool(
    "wowaudit_list_historical_data",
    "List roster activity for a Blizzard period, including completed dungeons, world quests, and Great Vault options.",
    mutationInput({
      period: {
        type: "integer",
        minimum: 1,
        description: "Blizzard period from wowaudit_get_period.",
      },
      limit: LIMIT_PROPERTY,
    }),
    READ_ANNOTATIONS,
    async (args) =>
      call("/v1/historical_data", {
        query: { period: optionalPositiveInteger(args, "period") },
        limit: optionalPositiveInteger(args, "limit"),
        collectionKey: "characters",
      }),
  ),
  defineTool(
    "wowaudit_get_character_history",
    "Get one character's activity history and best known gear by equipment slot.",
    idInput("WoWAudit character ID."),
    READ_ANNOTATIONS,
    async (args) =>
      call(`/v1/historical_data/${requirePositiveInteger(args, "id")}`),
  ),
  defineTool(
    "wowaudit_list_raids",
    "List upcoming raids, optionally including past raids, with schedule, instance, difficulty, status, and signup counts.",
    mutationInput({
      includePast: {
        type: "boolean",
        default: false,
        description: "Include past raids in addition to upcoming raids.",
      },
      limit: LIMIT_PROPERTY,
    }),
    READ_ANNOTATIONS,
    async (args) =>
      call("/v1/raids", {
        query: { include_past: optionalBoolean(args, "includePast") },
        limit: optionalPositiveInteger(args, "limit"),
        collectionKey: "raids",
      }),
  ),
  defineTool(
    "wowaudit_get_raid",
    "Get a raid's detailed signups, comments, selections, and enabled encounter plan.",
    idInput("WoWAudit raid ID."),
    READ_ANNOTATIONS,
    async (args) => call(`/v1/raids/${requirePositiveInteger(args, "id")}`),
  ),
  defineTool(
    "wowaudit_get_attendance",
    "Get attendance statistics, optionally scoped by instance, encounter, and date range.",
    mutationInput({
      instance: { type: "string", minLength: 1 },
      encounter: {
        type: "string",
        minLength: 1,
        description:
          "Encounter name or ID. WoWAudit ignores it without instance.",
      },
      startDate: { type: "string", format: "date" },
      endDate: { type: "string", format: "date" },
      limit: LIMIT_PROPERTY,
    }),
    READ_ANNOTATIONS,
    async (args) => {
      const instance = optionalString(args, "instance");
      const encounter = optionalString(args, "encounter");
      if (encounter && !instance) {
        throw new Error(
          'Argument "instance" is required when "encounter" is provided',
        );
      }
      return call("/v1/attendance", {
        query: {
          instance,
          encounter,
          start_date: optionalDate(args, "startDate"),
          end_date: optionalDate(args, "endDate"),
        },
        limit: optionalPositiveInteger(args, "limit"),
        collectionKey: "characters",
      });
    },
  ),
  defineTool(
    "wowaudit_list_wishlists",
    "List character Droptimizer wishlists and item upgrades. Prefer wowaudit_get_character_wishlist when one character is known because this response can be large.",
    mutationInput({ limit: LIMIT_PROPERTY }),
    READ_ANNOTATIONS,
    async (args) =>
      call("/v1/wishlists", {
        limit: optionalPositiveInteger(args, "limit"),
        collectionKey: "characters",
      }),
  ),
  defineTool(
    "wowaudit_get_character_wishlist",
    "Get detailed Droptimizer wishlist data for one character.",
    idInput("WoWAudit character ID."),
    READ_ANNOTATIONS,
    async (args) => call(`/v1/wishlists/${requirePositiveInteger(args, "id")}`),
  ),
  defineTool(
    "wowaudit_get_loot_history",
    "Get loot awarded during a keystone season, including recipients, award responses, old items, notes, and wishlist values.",
    mutationInput(
      {
        seasonId: {
          type: "integer",
          minimum: 1,
          description: "Keystone season ID from wowaudit_get_period.",
        },
        limit: LIMIT_PROPERTY,
      },
      ["seasonId"],
    ),
    READ_ANNOTATIONS,
    async (args) =>
      call(`/v1/loot_history/${requirePositiveInteger(args, "seasonId")}`, {
        limit: optionalPositiveInteger(args, "limit"),
        collectionKey: "history_items",
      }),
  ),
  defineTool(
    "wowaudit_list_applications",
    "List guild applications without full questionnaire details. Application data is sensitive and should only be used in officer-authorized contexts.",
    mutationInput({ limit: LIMIT_PROPERTY }),
    READ_ANNOTATIONS,
    async (args) => {
      requireApplicationsEnabled();
      return call("/v1/applications", {
        limit: optionalPositiveInteger(args, "limit"),
        collectionKey: "applications",
      });
    },
  ),
  defineTool(
    "wowaudit_get_application",
    "Get one sensitive guild application, including alts, questionnaire answers, and uploaded file links. Use only in officer-authorized contexts.",
    idInput("WoWAudit application ID."),
    READ_ANNOTATIONS,
    async (args) => {
      requireApplicationsEnabled();
      return call(`/v1/applications/${requirePositiveInteger(args, "id")}`);
    },
  ),

  defineTool(
    "wowaudit_track_character",
    "Start tracking a roster character. Requires WOWAUDIT_ENABLE_WRITES=true.",
    mutationInput(
      {
        name: { type: "string", minLength: 1 },
        realm: { type: "string", minLength: 1 },
        role: { type: "string", enum: ROLES },
        spec: { type: "string", minLength: 1 },
        rank: { type: "string", enum: RANKS },
        note: { type: "string", minLength: 1 },
      },
      ["name", "realm"],
    ),
    WRITE_ANNOTATIONS,
    async (args) =>
      call("/v1/characters", {
        method: "POST",
        body: compactObject({
          name: requireString(args, "name"),
          realm: requireString(args, "realm"),
          role: optionalEnum(args, "role", ROLES),
          spec: optionalString(args, "spec"),
          rank: optionalEnum(args, "rank", RANKS),
          note: optionalString(args, "note"),
        }),
      }),
  ),
  defineTool(
    "wowaudit_update_character",
    "Update a tracked character's role, spec, rank, or note. Requires WOWAUDIT_ENABLE_WRITES=true.",
    mutationInput(
      {
        id: { type: "integer", minimum: 1 },
        role: { type: "string", enum: ROLES },
        spec: { type: "string", minLength: 1 },
        rank: { type: "string", enum: RANKS },
        note: { type: "string", minLength: 1 },
      },
      ["id"],
    ),
    UPDATE_ANNOTATIONS,
    async (args) =>
      call(`/v1/characters/${requirePositiveInteger(args, "id")}`, {
        method: "PUT",
        body: requireNonEmptyBody(
          compactObject({
            role: optionalEnum(args, "role", ROLES),
            spec: optionalString(args, "spec"),
            rank: optionalEnum(args, "rank", RANKS),
            note: optionalString(args, "note"),
          }),
        ),
      }),
  ),
  defineTool(
    "wowaudit_untrack_character",
    "Stop tracking a character. Requires WOWAUDIT_ENABLE_WRITES=true and confirm=true.",
    destructiveIdInput("WoWAudit character ID."),
    DELETE_ANNOTATIONS,
    async (args) => {
      requireConfirmation(args);
      return call(`/v1/characters/${requirePositiveInteger(args, "id")}`, {
        method: "DELETE",
      });
    },
  ),
  defineTool(
    "wowaudit_create_raid",
    "Create one raid or a recurring season raid. Requires WOWAUDIT_ENABLE_WRITES=true.",
    mutationInput(
      {
        date: { type: "string", format: "date" },
        startTime: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
        endTime: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
        instance: { type: "string", minLength: 1 },
        entireSeason: { type: "boolean" },
        optional: { type: "boolean" },
        difficulty: { type: "string", enum: DIFFICULTIES },
      },
      ["date", "startTime", "endTime"],
    ),
    WRITE_ANNOTATIONS,
    async (args) =>
      call("/v1/raids", {
        method: "POST",
        body: compactObject({
          date: requireDate(args, "date"),
          start_time: requireTime(args, "startTime"),
          end_time: requireTime(args, "endTime"),
          instance: optionalString(args, "instance"),
          entire_season: optionalBoolean(args, "entireSeason"),
          optional: optionalBoolean(args, "optional"),
          difficulty: optionalEnum(args, "difficulty", DIFFICULTIES),
        }),
      }),
  ),
  defineTool(
    "wowaudit_update_raid",
    "Update raid status, schedule, difficulty, encounters, or signup selections. Requires WOWAUDIT_ENABLE_WRITES=true.",
    mutationInput(
      {
        id: { type: "integer", minimum: 1 },
        status: { type: "string", enum: RAID_STATUSES },
        startTime: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
        endTime: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
        optional: { type: "boolean" },
        difficulty: { type: "string", enum: DIFFICULTIES },
        enableEncounters: {
          type: "array",
          maxItems: 100,
          items: { type: "integer", minimum: 1 },
        },
        disableEncounters: {
          type: "array",
          maxItems: 100,
          items: { type: "integer", minimum: 1 },
        },
        signupChanges: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              character_id: { type: "integer", minimum: 1 },
              status: { type: "string", enum: SIGNUP_STATUSES },
              role: { type: "string", enum: ROLES },
              class: { type: "string", enum: CLASSES },
              comment: { type: "string" },
              selected: { type: "boolean" },
              encounter_changes: {
                type: "array",
                maxItems: 100,
                items: {
                  type: "object",
                  properties: {
                    encounter_id: { type: "integer", minimum: 1 },
                    role: { type: "string", enum: ROLES },
                    class: { type: "string", enum: CLASSES },
                    selected: { type: "boolean" },
                  },
                  required: ["encounter_id"],
                  additionalProperties: false,
                },
              },
            },
            required: ["character_id"],
            additionalProperties: false,
          },
        },
      },
      ["id"],
    ),
    UPDATE_ANNOTATIONS,
    async (args) =>
      call(`/v1/raids/${requirePositiveInteger(args, "id")}`, {
        method: "PUT",
        body: requireNonEmptyBody(
          compactObject({
            status: optionalEnum(args, "status", RAID_STATUSES),
            start_time:
              args.startTime === undefined
                ? undefined
                : requireTime(args, "startTime"),
            end_time:
              args.endTime === undefined
                ? undefined
                : requireTime(args, "endTime"),
            optional: optionalBoolean(args, "optional"),
            difficulty: optionalEnum(args, "difficulty", DIFFICULTIES),
            enable_encounters: optionalIntegerArray(args, "enableEncounters"),
            disable_encounters: optionalIntegerArray(args, "disableEncounters"),
            signup_changes: validateSignupChanges(
              optionalObjectArray(args, "signupChanges"),
            ),
          }),
        ),
      }),
  ),
  defineTool(
    "wowaudit_delete_raid",
    "Delete a raid. Requires WOWAUDIT_ENABLE_WRITES=true and confirm=true.",
    destructiveIdInput("WoWAudit raid ID."),
    DELETE_ANNOTATIONS,
    async (args) => {
      requireConfirmation(args);
      return call(`/v1/raids/${requirePositiveInteger(args, "id")}`, {
        method: "DELETE",
      });
    },
  ),
  defineTool(
    "wowaudit_upload_wishlist",
    "Upload a Raidbots Droptimizer report as a character wishlist. Requires WOWAUDIT_ENABLE_WRITES=true.",
    mutationInput(
      {
        reportId: { type: "string", minLength: 1 },
        characterId: { type: "integer", minimum: 1 },
        characterName: { type: "string", minLength: 1 },
        configurationName: { type: "string", minLength: 1 },
        replaceManualEdits: { type: "boolean" },
        clearConduits: { type: "boolean" },
      },
      ["reportId", "configurationName"],
    ),
    WRITE_ANNOTATIONS,
    async (args) => {
      const characterId = optionalPositiveInteger(args, "characterId");
      const characterName = optionalString(args, "characterName");
      if (!characterId && !characterName) {
        throw new Error(
          'Either "characterId" or "characterName" must be provided',
        );
      }
      return call("/v1/wishlists", {
        method: "POST",
        body: compactObject({
          report_id: requireString(args, "reportId"),
          character_id: characterId,
          character_name: characterName,
          configuration_name: requireString(args, "configurationName"),
          replace_manual_edits: optionalBoolean(args, "replaceManualEdits"),
          clear_conduits: optionalBoolean(args, "clearConduits"),
        }),
      });
    },
  ),
  defineTool(
    "wowaudit_delete_wishlist",
    "Delete all wishlist information for a character. Requires WOWAUDIT_ENABLE_WRITES=true and confirm=true.",
    destructiveIdInput("WoWAudit character ID."),
    DELETE_ANNOTATIONS,
    async (args) => {
      requireConfirmation(args);
      return call(`/v1/wishlists/${requirePositiveInteger(args, "id")}`, {
        method: "DELETE",
      });
    },
  ),
  defineTool(
    "wowaudit_update_application",
    "Update an application's status, private notes, or message. Requires WOWAUDIT_ENABLE_WRITES=true and an officer-authorized context.",
    mutationInput(
      {
        id: { type: "integer", minimum: 1 },
        status: { type: "string", enum: APPLICATION_STATUSES },
        notes: { type: "string", minLength: 1 },
        message: { type: "string", minLength: 1 },
      },
      ["id"],
    ),
    UPDATE_ANNOTATIONS,
    async (args) => {
      requireApplicationsEnabled();
      return call(`/v1/applications/${requirePositiveInteger(args, "id")}`, {
        method: "PUT",
        body: requireNonEmptyBody(
          compactObject({
            status: optionalEnum(args, "status", APPLICATION_STATUSES),
            notes: optionalString(args, "notes"),
            message: optionalString(args, "message"),
          }),
        ),
      });
    },
  ),
  defineTool(
    "wowaudit_delete_application",
    "Permanently delete an application. Requires WOWAUDIT_ENABLE_WRITES=true and confirm=true in an officer-authorized context.",
    destructiveIdInput("WoWAudit application ID."),
    DELETE_ANNOTATIONS,
    async (args) => {
      requireApplicationsEnabled();
      requireConfirmation(args);
      return call(`/v1/applications/${requirePositiveInteger(args, "id")}`, {
        method: "DELETE",
      });
    },
  ),
];

const TOOL_BY_NAME = new Map(
  TOOL_DESCRIPTORS.map((descriptor) => [
    descriptor.definition.name,
    descriptor,
  ]),
);

export function findTool(name: string): ToolDescriptor | undefined {
  const descriptor = TOOL_BY_NAME.get(name);
  return descriptor && isToolEnabled(descriptor) ? descriptor : undefined;
}

export function getAvailableTools(): Tool[] {
  return TOOL_DESCRIPTORS.filter(isToolEnabled).map(
    (descriptor) => descriptor.definition,
  );
}

function isToolEnabled(descriptor: ToolDescriptor): boolean {
  const flags = getFeatureFlags();
  const name = descriptor.definition.name;
  if (!flags.applicationsEnabled && name.includes("application")) return false;
  if (descriptor.definition.annotations?.readOnlyHint) return true;
  if (!flags.writesEnabled) return false;
  if (
    flags.writePolicy === "raidlens-create-update-v1" &&
    !RAIDLENS_WRITE_TOOLS.has(name)
  )
    return false;
  return true;
}

function requireApplicationsEnabled(): void {
  if (!getConfig().applicationsEnabled) {
    throw new Error(
      "WoWAudit application tools are disabled. Set WOWAUDIT_ENABLE_APPLICATIONS=true only when the MCP client enforces an officer-authorized context.",
    );
  }
}

function requireNonEmptyBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.keys(body).length === 0) {
    throw new Error("At least one field to update must be provided");
  }
  return body;
}

function validateSignupChanges(
  changes: Record<string, unknown>[] | undefined,
): Record<string, unknown>[] | undefined {
  if (!changes) return undefined;
  return changes.map((change, index) => {
    const characterId = change.character_id;
    if (!Number.isSafeInteger(characterId) || (characterId as number) < 1) {
      throw new Error(
        `signupChanges[${index}].character_id must be a positive integer`,
      );
    }
    const status = optionalEnum(change, "status", SIGNUP_STATUSES);
    const role = optionalEnum(change, "role", ROLES);
    const encounterChanges = optionalObjectArray(
      change,
      "encounter_changes",
      100,
    );
    const validatedEncounterChanges = encounterChanges?.map(
      (encounter, encounterIndex) => {
        if (
          !Number.isSafeInteger(encounter.encounter_id) ||
          (encounter.encounter_id as number) < 1
        ) {
          throw new Error(
            `signupChanges[${index}].encounter_changes[${encounterIndex}].encounter_id must be a positive integer`,
          );
        }
        return compactObject({
          encounter_id: encounter.encounter_id,
          role: optionalEnum(encounter, "role", ROLES),
          class: optionalEnum(encounter, "class", CLASSES),
          selected: optionalBoolean(encounter, "selected"),
        });
      },
    );
    return compactObject({
      character_id: characterId,
      status,
      role,
      class: optionalEnum(change, "class", CLASSES),
      comment: typeof change.comment === "string" ? change.comment : undefined,
      selected: optionalBoolean(change, "selected"),
      encounter_changes: validatedEncounterChanges,
    });
  });
}
