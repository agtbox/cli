const githubReference = /github\.com(?:\/|:)[^\s"'<>`]+/giu;
const trailingPunctuation = /[),.;:!?]+$/u;

function isAllowedGitHubReference(reference) {
  const normalized = reference.replace(trailingPunctuation, "");
  return /^github\.com(?:\/|:)agtbox\/cli(?:$|[/?#])/iu.test(normalized)
    || /^github\.com(?:\/|:)agtbox\/cli\.git(?:$|[?#])/iu.test(normalized)
    || /^github\.com\/sponsors\/(?:colinhacks|wevm)(?:$|[/?#])/iu.test(normalized);
}

export function hasNonPublicGitHubReference(content) {
  return [...content.matchAll(githubReference)].some((match) => !isAllowedGitHubReference(match[0]));
}
