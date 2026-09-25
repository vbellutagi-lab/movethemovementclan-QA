import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  apiBaseUrl: required("API_BASE_URL", "http://localhost:8000"),
  webBaseUrl: required("WEB_BASE_URL", "http://localhost:3000"),
  mailpitBaseUrl: required("MAILPIT_BASE_URL", "http://localhost:8025"),
  seedPassword: required("SEED_PASSWORD", "ChangeMe123!"),
  seedOrgSlug: required("SEED_ORG_SLUG", "move-dev"),
};
