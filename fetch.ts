/**
 * @packageDocumentation
 * Simple fetch utility used for downloading remote GGUF constants during development.
 */

const res = await fetch(
  "https://raw.githubusercontent.com/ggml-org/llama.cpp/master/gguf-py/gguf/constants.py",
);
const text = await res.text();
console.log(text);
