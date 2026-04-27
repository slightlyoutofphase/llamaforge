# GOAL
Your sole task is to complete a real full implementation of `LLAMAFORGE_PROJECT_PLAN.md`, with the correct multi file project structure exactly as the plan mandates.
# STRICTLY PROHIBITED:
Stub code, placeholder code, todos, simplifications, and any other kind of code that does not correctly fulfill **all** requirements of the project plan.
# REMEMBER:
This **IS** a real implementation. This **IS** a full implementation. The user will immediately notice any failure to implement the project plan correctly and fully.
# ULTIMATE SOURCES OF TRUTH:
The complete latest docs for the llama-server CLI executable are in `llama-server-docs.md`.
Gemma 4 prompt formatting docs:
https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4
Gemma 4 vision docs:
https://ai.google.dev/gemma/docs/capabilities/vision
Bun docs:
https://bun.com/docs
llama-cpp GGUF header constants (useful for default publisher-recommended inference sampling settings, i.e. general.sampling determination and capabilities, i.e. clip.has_vision_encoder or clip.has_audio_encoder determination per model):
https://github.com/ggml-org/llama.cpp/blob/master/gguf-py/gguf/constants.py