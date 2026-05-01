# GOAL
Your sole task is to complete a real full implementation of `LLAMAFORGE_PROJECT_PLAN.md`, with the correct multi file project structure exactly as the plan mandates.
# STRICTLY PROHIBITED:
Stub code, placeholder code, todos, simplifications, and any other kind of code that does not correctly fulfill **all** requirements of the project plan.
# REMEMBER:
This **IS** a real implementation. This **IS** a full implementation. The user will immediately notice any failure to implement the project plan correctly and fully.
You **ABSOLUTELY MUST AT ALL TIMES** follow the TypeScript compiler flag rules and TypeDoc documentation comment requirements that are outlined in the project plan.
You **ABSOLUTELY MUST AT ALL TIMES** consider edge cases and handle them properly. "Happy path only" programming is **NOT** acceptable.
# ULTIMATE SOURCES OF TRUTH:
The complete latest docs for the llama-server CLI executable are in `llama-server-docs.md` which can be found in the top-level project directory.
Gemma 4 prompt formatting docs:
https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4
Gemma 4 vision docs:
https://ai.google.dev/gemma/docs/capabilities/vision
Bun docs:
https://bun.com/docs
llama-cpp GGUF header constants (useful for determination of default publisher-recommended inference sampling settings from main LLM GGUF, i.e. general.sampling.xyz, and multimodal capabilities determination from companion MMPROJ GGUF when present, i.e. clip.has_vision_encoder or clip.has_audio_encoder):
https://github.com/ggml-org/llama.cpp/blob/master/gguf-py/gguf/constants.py