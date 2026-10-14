// Known destinations. Jev cannot generate URLs, so "go to Google Cloud billing"
// becomes a Choice over this catalog. Extend it with ~/.jev-guide/sites.json
// ({ "my_key": { "url": "...", "description": "..." } }).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const BUILTIN_SITES = {
  google_cloud_console: { url: "https://console.cloud.google.com/", description: "Google Cloud Platform (GCP) console home / dashboard" },
  google_cloud_billing: { url: "https://console.cloud.google.com/billing", description: "Google Cloud billing overview: billing accounts, costs, invoices" },
  google_cloud_billing_budgets: { url: "https://console.cloud.google.com/billing/budgets", description: "Google Cloud billing budgets and alerts" },
  google_cloud_iam: { url: "https://console.cloud.google.com/iam-admin/iam", description: "Google Cloud IAM: permissions, roles, principals, service accounts" },
  google_cloud_apis: { url: "https://console.cloud.google.com/apis/dashboard", description: "Google Cloud APIs & Services dashboard, enable APIs, credentials" },
  google_cloud_compute: { url: "https://console.cloud.google.com/compute/instances", description: "Google Cloud Compute Engine VM instances" },
  google_cloud_storage: { url: "https://console.cloud.google.com/storage/browser", description: "Google Cloud Storage buckets" },
  google_cloud_bigquery: { url: "https://console.cloud.google.com/bigquery", description: "Google Cloud BigQuery studio / SQL workspace" },
  google_cloud_run: { url: "https://console.cloud.google.com/run", description: "Google Cloud Run services" },
  google_cloud_kubernetes: { url: "https://console.cloud.google.com/kubernetes/list", description: "Google Kubernetes Engine (GKE) clusters" },
  google_cloud_logging: { url: "https://console.cloud.google.com/logs", description: "Google Cloud Logging / Logs Explorer" },
  google_cloud_monitoring: { url: "https://console.cloud.google.com/monitoring", description: "Google Cloud Monitoring dashboards and alerts" },
  google_cloud_vertex: { url: "https://console.cloud.google.com/vertex-ai", description: "Google Cloud Vertex AI" },
  google_cloud_projects: { url: "https://console.cloud.google.com/cloud-resource-manager", description: "Google Cloud project list / create project" },
  google_search: { url: "https://www.google.com/", description: "Google web search home page" },
  gmail: { url: "https://mail.google.com/", description: "Gmail inbox" },
  google_drive: { url: "https://drive.google.com/", description: "Google Drive files" },
  google_calendar: { url: "https://calendar.google.com/", description: "Google Calendar" },
  google_docs: { url: "https://docs.google.com/", description: "Google Docs" },
  google_sheets: { url: "https://sheets.google.com/", description: "Google Sheets" },
  youtube: { url: "https://www.youtube.com/", description: "YouTube" },
  github: { url: "https://github.com/", description: "GitHub" },
  aws_console: { url: "https://console.aws.amazon.com/", description: "Amazon Web Services (AWS) console" },
  azure_portal: { url: "https://portal.azure.com/", description: "Microsoft Azure portal" },
  linkedin: { url: "https://www.linkedin.com/", description: "LinkedIn" },
  chatgpt: { url: "https://chatgpt.com/", description: "ChatGPT" },
  claude: { url: "https://claude.ai/", description: "Claude by Anthropic" },
};

export function loadSites() {
  const custom = path.join(os.homedir(), ".jev-guide", "sites.json");
  let extra = {};
  try {
    if (fs.existsSync(custom)) extra = JSON.parse(fs.readFileSync(custom, "utf8"));
  } catch (e) {
    console.warn(`[sites] could not parse ${custom}: ${e.message}`);
  }
  return { ...BUILTIN_SITES, ...extra };
}

// Pull explicit URLs / domains out of the spoken text ("go to example dot com").
export function extractUrls(text) {
  const t = text.replace(/\s+dot\s+/gi, ".").replace(/\s+slash\s+/gi, "/");
  const found = new Set();
  const re = /\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|dev|app|co|gov|edu|cloud)(?:\/[^\s,;]*)?)/gi;
  for (const m of t.matchAll(re)) {
    let u = m[1];
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    found.add(u.replace(/[.,;:]+$/, ""));
  }
  return [...found];
}
