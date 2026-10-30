export function googleOAuthScopes(profile = "legacy") {
  if (profile === "drive-readonly") return [
    "https://www.googleapis.com/auth/documents.readonly",
    "https://www.googleapis.com/auth/drive.metadata.readonly",
  ];
  if (profile !== "legacy") throw new Error("Unknown Google OAuth profile");
  return [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/script.scriptapp",
    "https://www.googleapis.com/auth/documents.readonly",
    "https://www.googleapis.com/auth/drive.metadata.readonly",
  ];
}
