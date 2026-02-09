#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";

// ── ANSI Colors ──
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgMagenta: "\x1b[45m",
};

const isTTY = process.stdout.isTTY;

function paint(color: string, text: string): string {
  return isTTY ? `${color}${text}${c.reset}` : text;
}

// ── Help ──
function showHelp(): void {
  console.log(`
${paint(c.bgMagenta + c.white + c.bold, " openapi-mock ")} ${paint(c.dim, "v1.0.0")}

${paint(c.bold, "Mock server from OpenAPI 3.x specs.")}

${paint(c.yellow, "USAGE")}
  openapi-mock <spec-file> [options]

${paint(c.yellow, "ARGUMENTS")}
  ${paint(c.green, "<spec-file>")}     Path to OpenAPI 3.x JSON spec file

${paint(c.yellow, "OPTIONS")}
  ${paint(c.cyan, "--port <n>")}       Port to listen on (default: 3000)
  ${paint(c.cyan, "--delay <ms>")}     Add latency to responses in milliseconds
  ${paint(c.cyan, "--validate")}       Validate incoming request bodies against schemas
  ${paint(c.cyan, "--json")}           Output request logs as JSON
  ${paint(c.cyan, "--help")}           Show this help message

${paint(c.yellow, "FEATURES")}
  - Auto-generates realistic mock data from schema types
  - Supports string, number, integer, boolean, array, object schemas
  - Handles $ref references within components/schemas
  - Respects enum values, format hints (email, uri, uuid, date-time)
  - Returns proper HTTP status codes from spec
  - Request body validation against schema (with --validate)

${paint(c.yellow, "EXAMPLES")}
  ${paint(c.dim, "# Start mock server on default port")}
  openapi-mock ./petstore.json

  ${paint(c.dim, "# Custom port with 200ms latency")}
  openapi-mock ./api-spec.json --port 8080 --delay 200

  ${paint(c.dim, "# With request validation")}
  openapi-mock ./spec.json --validate

${paint(c.dim, "Built by LXGIC Studios")} ${paint(c.blue, "https://github.com/lxgicstudios/openapi-mock")}
`);
}

// ── Types ──
interface OpenAPISpec {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, PathItem>;
  components?: { schemas?: Record<string, SchemaObject> };
}

interface PathItem {
  [method: string]: OperationObject | undefined;
}

interface OperationObject {
  operationId?: string;
  summary?: string;
  requestBody?: {
    content?: Record<string, { schema?: SchemaObject }>;
    required?: boolean;
  };
  responses: Record<string, ResponseObject>;
}

interface ResponseObject {
  description?: string;
  content?: Record<string, { schema?: SchemaObject }>;
}

interface SchemaObject {
  type?: string;
  format?: string;
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  required?: string[];
  enum?: unknown[];
  $ref?: string;
  allOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  default?: unknown;
  example?: unknown;
  nullable?: boolean;
}

// ── Mock Data Generator ──
let counter = 0;

function generateMockValue(schema: SchemaObject, spec: OpenAPISpec, depth: number = 0): unknown {
  if (depth > 10) return null;

  // Handle $ref
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, spec);
    if (resolved) return generateMockValue(resolved, spec, depth + 1);
    return null;
  }

  // Handle allOf
  if (schema.allOf) {
    const merged: Record<string, unknown> = {};
    for (const sub of schema.allOf) {
      const val = generateMockValue(sub, spec, depth + 1);
      if (val && typeof val === "object" && !Array.isArray(val)) {
        Object.assign(merged, val);
      }
    }
    return merged;
  }

  // Handle oneOf / anyOf - just pick the first
  if (schema.oneOf?.[0]) return generateMockValue(schema.oneOf[0], spec, depth + 1);
  if (schema.anyOf?.[0]) return generateMockValue(schema.anyOf[0], spec, depth + 1);

  // Use example if provided
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;

  // Use enum
  if (schema.enum && schema.enum.length > 0) {
    return schema.enum[counter++ % schema.enum.length];
  }

  switch (schema.type) {
    case "string":
      return generateString(schema);
    case "number":
    case "integer":
      return generateNumber(schema);
    case "boolean":
      return counter++ % 2 === 0;
    case "array":
      if (schema.items) {
        const count = 2;
        return Array.from({ length: count }, () => generateMockValue(schema.items!, spec, depth + 1));
      }
      return [];
    case "object":
      return generateObject(schema, spec, depth);
    default:
      // If there are properties, treat as object
      if (schema.properties) return generateObject(schema, spec, depth);
      return "mock-value";
  }
}

function generateString(schema: SchemaObject): string {
  counter++;
  switch (schema.format) {
    case "email":
      return `user${counter}@example.com`;
    case "uri":
    case "url":
      return `https://example.com/resource/${counter}`;
    case "uuid":
      return `550e8400-e29b-41d4-a716-44665544${String(counter).padStart(4, "0")}`;
    case "date":
      return "2026-01-15";
    case "date-time":
      return "2026-01-15T10:30:00Z";
    case "ipv4":
      return `192.168.1.${counter % 255}`;
    case "ipv6":
      return "::1";
    case "hostname":
      return `host${counter}.example.com`;
    case "password":
      return "********";
    default: {
      const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
      return names[counter % names.length] + `-${counter}`;
    }
  }
}

function generateNumber(schema: SchemaObject): number {
  counter++;
  const min = schema.minimum ?? 0;
  const max = schema.maximum ?? 100;
  const val = min + (counter % (max - min + 1));
  return schema.type === "integer" ? Math.floor(val) : parseFloat(val.toFixed(2));
}

function generateObject(schema: SchemaObject, spec: OpenAPISpec, depth: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      result[key] = generateMockValue(propSchema, spec, depth + 1);
    }
  }
  return result;
}

function resolveRef(ref: string, spec: OpenAPISpec): SchemaObject | null {
  // #/components/schemas/Pet
  const parts = ref.replace(/^#\//, "").split("/");
  let current: unknown = spec;
  for (const part of parts) {
    if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }
  return (current as SchemaObject) || null;
}

// ── Request Validator ──
function validateBody(body: unknown, schema: SchemaObject, spec: OpenAPISpec): string[] {
  const errors: string[] = [];

  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, spec);
    if (resolved) return validateBody(body, resolved, spec);
    return errors;
  }

  if (body === null || body === undefined) {
    return ["Request body is required"];
  }

  if (schema.type === "object" && schema.properties) {
    if (typeof body !== "object" || Array.isArray(body)) {
      errors.push("Expected object");
      return errors;
    }
    const record = body as Record<string, unknown>;
    for (const reqField of schema.required || []) {
      if (!(reqField in record)) {
        errors.push(`Missing required field: ${reqField}`);
      }
    }
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in record) {
        const fieldErrors = validateBody(record[key], propSchema, spec);
        errors.push(...fieldErrors.map((e) => `${key}: ${e}`));
      }
    }
  }

  if (schema.type === "string" && typeof body !== "string") {
    errors.push(`Expected string, got ${typeof body}`);
  }

  if ((schema.type === "number" || schema.type === "integer") && typeof body !== "number") {
    errors.push(`Expected number, got ${typeof body}`);
  }

  if (schema.type === "boolean" && typeof body !== "boolean") {
    errors.push(`Expected boolean, got ${typeof body}`);
  }

  return errors;
}

// ── Route Matching ──
function matchRoute(
  specPath: string,
  requestPath: string
): Record<string, string> | null {
  const specParts = specPath.split("/").filter(Boolean);
  const reqParts = requestPath.split("/").filter(Boolean);

  if (specParts.length !== reqParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < specParts.length; i++) {
    if (specParts[i].startsWith("{") && specParts[i].endsWith("}")) {
      const paramName = specParts[i].slice(1, -1);
      params[paramName] = reqParts[i];
    } else if (specParts[i] !== reqParts[i]) {
      return null;
    }
  }
  return params;
}

// ── Read body ──
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => resolve(data));
  });
}

// ── Main ──
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    showHelp();
    process.exit(0);
  }

  const portIdx = args.indexOf("--port");
  const port = portIdx !== -1 && args[portIdx + 1] ? parseInt(args[portIdx + 1], 10) : 3000;

  const delayIdx = args.indexOf("--delay");
  const delay = delayIdx !== -1 && args[delayIdx + 1] ? parseInt(args[delayIdx + 1], 10) : 0;

  const validate = args.includes("--validate");
  const jsonOutput = args.includes("--json");

  const specFile = args.find((a) => !a.startsWith("--") && args.indexOf(a) === 0) || args[0];

  if (!specFile || specFile.startsWith("--")) {
    console.error(paint(c.red, "Error: No spec file provided."));
    process.exit(1);
  }

  let specRaw: string;
  try {
    specRaw = readFileSync(specFile, "utf8");
  } catch {
    console.error(paint(c.red, `Error: Can't read file "${specFile}".`));
    process.exit(1);
  }

  let spec: OpenAPISpec;
  try {
    spec = JSON.parse(specRaw);
  } catch {
    console.error(paint(c.red, "Error: Invalid JSON in spec file."));
    process.exit(1);
  }

  if (!spec.openapi || !spec.paths) {
    console.error(paint(c.red, "Error: Doesn't look like a valid OpenAPI spec (missing openapi or paths)."));
    process.exit(1);
  }

  const routeCount = Object.keys(spec.paths).length;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const method = (req.method || "GET").toLowerCase();
    const url = new URL(req.url || "/", `http://localhost:${port}`);
    const pathname = url.pathname;
    const startTime = Date.now();

    // Find matching route
    let matchedPath: string | null = null;
    let matchedOp: OperationObject | null = null;

    for (const [specPath, pathItem] of Object.entries(spec.paths)) {
      const params = matchRoute(specPath, pathname);
      if (params !== null) {
        const op = pathItem[method] as OperationObject | undefined;
        if (op) {
          matchedPath = specPath;
          matchedOp = op;
          break;
        }
      }
    }

    if (!matchedOp || !matchedPath) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Route not found", path: pathname, method: method.toUpperCase() }));
      return;
    }

    // Validate request body if needed
    if (validate && matchedOp.requestBody?.content) {
      const bodyStr = await readBody(req);
      if (bodyStr) {
        try {
          const bodyData = JSON.parse(bodyStr);
          const contentType = Object.keys(matchedOp.requestBody.content)[0];
          const bodySchema = matchedOp.requestBody.content[contentType]?.schema;
          if (bodySchema) {
            const errors = validateBody(bodyData, bodySchema, spec);
            if (errors.length > 0) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ errors }));
              return;
            }
          }
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON in request body" }));
          return;
        }
      } else if (matchedOp.requestBody.required) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body is required" }));
        return;
      }
    }

    // Find response schema - prefer 200, then 201, then first
    const responseKeys = Object.keys(matchedOp.responses);
    const successKey = responseKeys.find((k) => k === "200") ||
      responseKeys.find((k) => k === "201") ||
      responseKeys[0] || "200";
    const statusCode = parseInt(successKey, 10) || 200;
    const responseObj = matchedOp.responses[successKey];

    let responseBody: unknown = {};
    if (responseObj?.content) {
      const contentType = Object.keys(responseObj.content)[0];
      const schema = responseObj.content[contentType]?.schema;
      if (schema) {
        responseBody = generateMockValue(schema, spec);
      }
    }

    const respond = () => {
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responseBody, null, 2));

      const elapsed = Date.now() - startTime;
      if (jsonOutput) {
        console.log(JSON.stringify({ method: method.toUpperCase(), path: pathname, status: statusCode, ms: elapsed }));
      } else {
        const methodColor = method === "get" ? c.green : method === "post" ? c.yellow : method === "delete" ? c.red : c.blue;
        console.log(
          `  ${paint(methodColor, method.toUpperCase().padEnd(7))} ${paint(c.white, pathname.padEnd(30))} ${paint(c.cyan, String(statusCode))} ${paint(c.dim, elapsed + "ms")}`
        );
      }
    };

    if (delay > 0) {
      setTimeout(respond, delay);
    } else {
      respond();
    }
  });

  server.listen(port, () => {
    console.log("");
    console.log(paint(c.bgMagenta + c.white + c.bold, " openapi-mock "));
    console.log("");
    console.log(`  ${paint(c.bold, "Spec:")}    ${paint(c.cyan, spec.info.title)} ${paint(c.dim, "v" + spec.info.version)}`);
    console.log(`  ${paint(c.bold, "Routes:")}  ${paint(c.green, String(routeCount))} endpoints`);
    console.log(`  ${paint(c.bold, "Server:")}  ${paint(c.cyan, `http://localhost:${port}`)}`);
    if (delay) console.log(`  ${paint(c.bold, "Delay:")}   ${paint(c.yellow, delay + "ms")}`);
    if (validate) console.log(`  ${paint(c.bold, "Validate:")} ${paint(c.green, "enabled")}`);
    console.log("");
    console.log(paint(c.dim, "  Waiting for requests..."));
    console.log("");

    // List routes
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      for (const method of Object.keys(pathItem)) {
        if (["get", "post", "put", "patch", "delete", "options", "head"].includes(method)) {
          const op = pathItem[method] as OperationObject;
          const methodColor = method === "get" ? c.green : method === "post" ? c.yellow : method === "delete" ? c.red : c.blue;
          console.log(`  ${paint(methodColor, method.toUpperCase().padEnd(7))} ${path} ${paint(c.dim, op.summary || "")}`);
        }
      }
    }
    console.log("");
  });
}

main().catch((err) => {
  console.error(paint(c.red, `Fatal: ${(err as Error).message}`));
  process.exit(1);
});
