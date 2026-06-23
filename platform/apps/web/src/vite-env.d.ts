/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_ENV?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_SUPABASE_DEV_URL?: string;
  readonly VITE_SUPABASE_DEV_ANON_KEY?: string;
  readonly VITE_SUPABASE_PROD_URL?: string;
  readonly VITE_SUPABASE_PROD_ANON_KEY?: string;
  readonly VITE_DEV_LOGIN_EMAIL?: string;
  readonly VITE_DEV_LOGIN_PASSWORD?: string;
  readonly VITE_PROD_LOGIN_EMAIL?: string;
  readonly VITE_PROD_LOGIN_PASSWORD?: string;
  readonly VITE_BROKER_BASE?: string;
  readonly VITE_LOCAL_RUNTIME_HELPER_BASE?: string;
  readonly VITE_OPENMACAW_APP_BASE_URL?: string;
  readonly VITE_WORKER_BRIDGE_DEFAULT_CWD?: string;
  readonly VITE_DEV_OPENAI_API_KEY?: string;
  readonly VITE_DEV_ANTHROPIC_API_KEY?: string;
  readonly VITE_DEV_XAI_API_KEY?: string;
  readonly VITE_DEV_GEMINI_API_KEY?: string;
  readonly VITE_DEV_MISTRAL_API_KEY?: string;
  readonly VITE_DEV_GROQ_API_KEY?: string;
  readonly VITE_DEV_OPENROUTER_API_KEY?: string;
  readonly VITE_DEV_TOGETHER_API_KEY?: string;
  readonly VITE_DEV_PERPLEXITY_API_KEY?: string;
  readonly VITE_DEV_AZURE_OPENAI_API_KEY?: string;
  readonly VITE_DEV_OPENAI_CODEX_ACCESS_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
