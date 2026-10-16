// Rename this file to config.js and fill in your keys.
// NEVER commit real keys. config.js is gitignored via .env pattern.

window.STEALTH_CONFIG = {
  // NOWPayments API key from https://account.nowpayments.io/
  NOWPAYMENTS_API_KEY: "YOUR_NOWPAYMENTS_API_KEY_HERE",

  // Optional: IPN secret for webhook verification (set same in NOWPayments dashboard)
  NOWPAYMENTS_IPN_SECRET: "YOUR_IPN_SECRET_HERE",

  // Base URL of this site (used for success/cancel redirects). Change when you deploy.
  SITE_URL: "http://localhost:8080",

  // Admin login (email must match a registered user + this password override, or use these creds)
  ADMIN_EMAIL: "admin@stealth.local",
  ADMIN_PASSWORD: "CHANGE_ME_ADMIN_PASS",

  // Plans (all lifetime)
  PLANS: {
    starter: { name: "Starter", price: 149, label: "lifetime" },
    pro: { name: "Pro", price: 249, label: "lifetime" },
    elite: { name: "Elite", price: 549, label: "lifetime" }
  }
};
