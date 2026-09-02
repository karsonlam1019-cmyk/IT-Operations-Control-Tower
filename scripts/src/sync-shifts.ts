import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { syncMain } from "./verify-shift-sync";

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await syncMain();
}