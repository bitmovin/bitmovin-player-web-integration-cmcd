const parseChangelog = require('changelog-parser');
const semver = require('semver');

const INCREMENTS = ['patch', 'minor', 'major'];

/**
 * Returns the next version. The increment is derived from the unreleased Changelog entries.
 * `bump` (`major`, `minor` or `patch`) overrides it, but must not be lower than the derived one.
 */
async function defineReleaseVersion({ core }, currentVersion, changelogFile, bump = 'auto') {
  return parseChangelog(changelogFile).then((result) => {
    const unreleased = result.versions.find((entry) => entry.version === null);

    if (!unreleased.parsed) {
      core.error('No unreleased section found', unreleased);
      return;
    }

    const parsedSections = unreleased.parsed;

    const hasAddedSection = parsedSections.Added && parsedSections.Added.length > 0;
    const hasChangedSection = parsedSections.Changed && parsedSections.Changed.length > 0;
    const hasRemovedSection = parsedSections.Removed && parsedSections.Removed.length > 0;

    const hasFixedSection = parsedSections.Fixed && parsedSections.Fixed.length > 0;
    const hasSecurityEntries = parsedSections.Security && parsedSections.Security.length > 0;
    const hasDeprecatedEntries = parsedSections.Deprecated && parsedSections.Deprecated.length > 0;

    let increment;
    if (hasAddedSection || hasChangedSection || hasRemovedSection) {
      increment = 'minor';
    } else if (hasFixedSection || hasSecurityEntries || hasDeprecatedEntries) {
      increment = 'patch';
    } else {
      core.error('No valid entries to release', unreleased);
      return;
    }

    if (bump && bump !== 'auto') {
      if (INCREMENTS.indexOf(bump) < INCREMENTS.indexOf(increment)) {
        core.setFailed(`Requested ${bump} increment is lower than the ${increment} increment of the Changelog entries`);
        return;
      }
      increment = bump;
    }

    const version = semver.inc(currentVersion, increment);
    core.info(`Increase version from ${currentVersion} to ${version}`);
    return version;
  });
}

module.exports.defineReleaseVersion = defineReleaseVersion;
