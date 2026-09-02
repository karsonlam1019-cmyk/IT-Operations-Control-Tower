#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CohereClientV2 } from "cohere-ai";
import { createClient } from "@supabase/supabase-js";
import { PDFParse } from "pdf-parse";
import "dotenv/config";

export const POLICIES_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "policies",
);
export const EMBEDDING_DIMENSIONS = 1024;
export const CHUNK_TOKEN_LIMIT = 500;
export const CHUNK_TOKEN_OVERLAP = 50;
export const EMBEDDING_BATCH_SIZE = 96;
export const EMBEDDING_MODEL = "embed-v4.0";
const TABLE_NAME = "policy_chunks";
const MAX_RETRIES = 3;

const REQUIRED_ENVIRONMENT = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "COHERE_API_KEY",
];

class IngestionError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "IngestionError";
  }
}

/**
 * Read required values without ever logging them. A missing value is reported
 * by name only so this command is safe to run in shared logs.
 */
export function validateEnvironment(environment = process.env) {
  const missing = REQUIRED_ENVIRONMENT.filter(
    (name) =>
      typeof environment[name] !== "string" || !environment[name].trim(),
  );

  if (missing.length > 0) {
    throw new IngestionError(
      `Missing required environment variable${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. ` +
        "Add these as Replit Secrets (or export them before running node ingest.js).",
    );
  }

  try {
    new URL(environment.SUPABASE_URL);
  } catch {
    throw new IngestionError(
      "SUPABASE_URL must be a valid URL. Check the value in the Replit Secret.",
    );
  }

  return {
    supabaseUrl: environment.SUPABASE_URL.trim(),
    supabaseServiceRoleKey: environment.SUPABASE_SERVICE_ROLE_KEY,
    cohereApiKey: environment.COHERE_API_KEY,
  };
}

export async function discoverPolicyFiles(directory = POLICIES_DIRECTORY) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new IngestionError(
        `Policy folder not found at ${directory}. Create it and add PDF files before running ingestion.`,
      );
    }
    throw new IngestionError(
      `Unable to read the policy folder: ${safeErrorMessage(error)}`,
    );
  }

  const files = entries
    .filter(
      (entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".pdf",
    )
    .map((entry) => join(directory, entry.name))
    .sort((left, right) => basename(left).localeCompare(basename(right)));

  if (files.length === 0) {
    throw new IngestionError(
      `No PDF files found in ${directory}. Add one or more policy PDFs; other file types are ignored.`,
    );
  }

  return files;
}

function normalizeLine(line) {
  return line.replace(/\s+/g, " ").trim();
}

function parseSectionHeading(line) {
  const match = line.match(/^((?:\d+\.)*\d+\.?)\s+(.+)$/);
  if (!match) return null;
  return `${match[1].replace(/\.$/, "")} ${match[2].trim()}`;
}

function tokenize(text) {
  return text.match(/\S+/g) ?? [];
}

function languageForText(text) {
  return /[\u3400-\u9fff]/u.test(text) ? "zh" : "en";
}

/**
 * Chunk each page independently. This keeps page_number exact even when a
 * document has a page break in the middle of a 500-token window.
 */
export function chunkPages(pages) {
  const chunks = [];
  let previousSection = null;

  for (const page of pages) {
    const pageNumber = Number(page.num);
    const lines = String(page.text ?? "")
      .split(/\r?\n/)
      .map(normalizeLine)
      .filter(Boolean);
    const pageTokens = [];
    let section = previousSection;

    for (const line of lines) {
      const heading = parseSectionHeading(line);
      if (heading) section = heading;
      for (const token of tokenize(line)) {
        pageTokens.push({ token, section });
      }
    }

    previousSection = section;
    if (pageTokens.length === 0) continue;

    const step = CHUNK_TOKEN_LIMIT - CHUNK_TOKEN_OVERLAP;
    for (let start = 0; start < pageTokens.length; start += step) {
      const window = pageTokens.slice(start, start + CHUNK_TOKEN_LIMIT);
      if (window.length === 0) break;
      chunks.push({
        content: window.map(({ token }) => token).join(" "),
        pageNumber,
        sectionReference:
          window.find(({ section }) => section)?.section ?? null,
      });
      if (start + CHUNK_TOKEN_LIMIT >= pageTokens.length) break;
    }
  }

  return chunks;
}

async function extractDocument(filePath) {
  let parser;
  try {
    const data = new Uint8Array(await readFile(filePath));
    if (data.length === 0) {
      throw new IngestionError(`PDF is empty: ${basename(filePath)}`);
    }

    parser = new PDFParse({ data });
    const result = await parser.getText();
    const pages = Array.isArray(result?.pages) ? result.pages : [];
    const text = pages
      .map((page) => String(page.text ?? ""))
      .join("\n")
      .trim();

    if (pages.length === 0 || !text) {
      throw new IngestionError(
        `${basename(filePath)} has no extractable text. Scanned/image-only PDFs are not supported.`,
      );
    }

    const chunks = chunkPages(pages);
    if (chunks.length === 0) {
      throw new IngestionError(
        `${basename(filePath)} could not be converted into text chunks.`,
      );
    }

    return {
      title: basename(filePath),
      language: languageForText(text),
      pages: pages.length,
      characters: text.length,
      chunks,
    };
  } catch (error) {
    if (error instanceof IngestionError) throw error;
    throw new IngestionError(
      `Unable to parse ${basename(filePath)}. Confirm it is a readable, unencrypted PDF. ` +
        `Parser error: ${safeErrorMessage(error)}`,
    );
  } finally {
    if (parser) {
      try {
        await parser.destroy();
      } catch {
        // Parsing already succeeded or failed; cleanup errors do not obscure
        // the actionable parse error.
      }
    }
  }
}

function safeErrorMessage(error, secrets = []) {
  let message;
  if (error instanceof Error) {
    message = error.message;
  } else if (error && typeof error === "object") {
    try {
      message = JSON.stringify(error);
    } catch {
      message = String(error);
    }
  } else {
    message = String(error);
  }
  const environmentSecrets = REQUIRED_ENVIRONMENT.map(
    (name) => process.env[name],
  );
  for (const secret of [...secrets, ...environmentSecrets]) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return message.replace(
    /\b(sk-[A-Za-z0-9_-]+|key-[A-Za-z0-9_-]+)\b/g,
    "[redacted]",
  );
}

function isRetryableError(error) {
  const status = Number(
    error?.statusCode ?? error?.status ?? error?.response?.status,
  );
  return (
    !Number.isFinite(status) ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500
  );
}

function wait(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

async function embedBatch(client, texts, secrets) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await client.embed({
        model: EMBEDDING_MODEL,
        inputType: "search_document",
        texts,
        embeddingTypes: ["float"],
        outputDimension: EMBEDDING_DIMENSIONS,
        truncate: "END",
      });
      const embeddings = response?.embeddings?.float;
      if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
        throw new IngestionError(
          `Cohere returned ${Array.isArray(embeddings) ? embeddings.length : 0} embeddings for ${texts.length} chunks.`,
        );
      }
      return embeddings;
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === MAX_RETRIES) break;
      await wait(500 * 2 ** (attempt - 1));
    }
  }

  throw new IngestionError(
    `Cohere embedding request failed after ${MAX_RETRIES} attempt${MAX_RETRIES === 1 ? "" : "s"}: ` +
      safeErrorMessage(lastError, secrets),
  );
}

async function generateEmbeddings(chunks, apiKey) {
  const client = new CohereClientV2({ token: apiKey });
  const embeddings = [];

  for (let start = 0; start < chunks.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = chunks.slice(start, start + EMBEDDING_BATCH_SIZE);
    const result = await embedBatch(
      client,
      batch.map(({ content }) => content),
      [apiKey],
    );
    embeddings.push(...result);
    console.log(
      `Embedded chunks ${start + 1}-${start + result.length} of ${chunks.length}.`,
    );
  }

  const invalid = embeddings.findIndex(
    (embedding) =>
      !Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS,
  );
  if (invalid !== -1) {
    const actual = Array.isArray(embeddings[invalid])
      ? embeddings[invalid].length
      : 0;
    throw new IngestionError(
      `Cohere returned embedding dimension ${actual}, but policy_chunks.embedding requires ${EMBEDDING_DIMENSIONS}. ` +
        "Stop without writing rows and use a Cohere model/output dimension compatible with vector(1024).",
    );
  }

  return embeddings;
}

function vectorLiteral(vector) {
  return `[${vector.join(",")}]`;
}

function rowsForDocument(document, embeddings) {
  return document.chunks.map((chunk, index) => ({
    document_name: `${document.title}#${String(index).padStart(4, "0")}`,
    page_number: chunk.pageNumber,
    paragraph_index: index,
    content: chunk.content,
    embedding: vectorLiteral(embeddings[index]),
  }));
}

async function writeDocuments(documents, embeddingsByDocument, configuration) {
  const supabase = createClient(
    configuration.supabaseUrl,
    configuration.supabaseServiceRoleKey,
    {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    },
  );

  for (const document of documents) {
    const { error: deleteError } = await supabase
      .from(TABLE_NAME)
      .delete()
      .or(
        `document_name.eq.${document.title},document_name.like.${document.title}#%`,
      );
    if (deleteError) {
      throw new IngestionError(
        `Could not replace existing rows for ${document.title}: ${safeErrorMessage(
          deleteError,
          [configuration.supabaseServiceRoleKey],
        )}`,
      );
    }

    const rows = rowsForDocument(
      document,
      embeddingsByDocument.get(document.title) ?? [],
    );
    for (let start = 0; start < rows.length; start += EMBEDDING_BATCH_SIZE) {
      const { error: insertError } = await supabase
        .from(TABLE_NAME)
        .insert(rows.slice(start, start + EMBEDDING_BATCH_SIZE));
      if (insertError) {
        throw new IngestionError(
          `Could not write policy vectors for ${document.title}: ${safeErrorMessage(
            insertError,
            [configuration.supabaseServiceRoleKey],
          )}`,
        );
      }
    }
    console.log(`Indexed ${rows.length} chunks for ${document.title}.`);
  }
}

function printSummary(documents) {
  console.log("Policy ingestion dry-run");
  console.log(`Policy folder: ${POLICIES_DIRECTORY}`);
  console.log(`PDFs discovered: ${documents.length}`);
  for (const document of documents) {
    console.log(
      `- ${document.title}: ${document.pages} pages, ${document.characters} extracted characters, ` +
        `${document.chunks.length} chunks, language=${document.language}`,
    );
  }
  console.log(
    `Embedding dimensionality: ${EMBEDDING_DIMENSIONS} (configured for ${EMBEDDING_MODEL}; Cohere and Supabase were not called).`,
  );
}

export async function runIngestion({
  dryRun = false,
  environment = process.env,
  directory = POLICIES_DIRECTORY,
} = {}) {
  const configuration = validateEnvironment(environment);
  const files = await discoverPolicyFiles(directory);
  const documents = [];

  for (const filePath of files) {
    console.log(`Extracting ${basename(filePath)}...`);
    documents.push(await extractDocument(filePath));
  }

  printSummary(documents);
  if (dryRun) return { documents, dryRun: true };

  const embeddingsByDocument = new Map();
  for (const document of documents) {
    embeddingsByDocument.set(
      document.title,
      await generateEmbeddings(document.chunks, configuration.cohereApiKey),
    );
  }
  await writeDocuments(documents, embeddingsByDocument, configuration);
  console.log(
    `Completed policy ingestion: ${documents.reduce(
      (total, document) => total + document.chunks.length,
      0,
    )} chunks indexed.`,
  );
  return { documents, dryRun: false };
}

function parseArguments(argumentsList) {
  const allowed = new Set(["--dry-run"]);
  const unknown = argumentsList.filter((argument) => !allowed.has(argument));
  if (unknown.length > 0) {
    throw new IngestionError(
      `Unknown argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Usage: node ingest.js [--dry-run]`,
    );
  }
  return { dryRun: argumentsList.includes("--dry-run") };
}

async function main() {
  const { dryRun } = parseArguments(process.argv.slice(2));
  await runIngestion({ dryRun });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`Policy ingestion failed: ${safeErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
