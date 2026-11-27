/**
 * @jest-environment node
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { defineReleaseVersion } = require('../../.github/scripts/defineVersion');

const changelog = (section) =>
  `# Changelog\n\n## [Unreleased]\n${section}\n\n## [0.6.2] - 2026-11-27\n### Fixed\n- Old fix\n`;

describe('defineReleaseVersion', () => {
  let dir;
  let core;

  const define = (section, bump) => {
    const file = path.join(dir, 'CHANGELOG.md');
    fs.writeFileSync(file, changelog(section));
    return defineReleaseVersion({ core }, '0.6.2', file, bump);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'define-version-'));
    core = { info: jest.fn(), error: jest.fn(), setFailed: jest.fn() };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['### Added\n- Feature', undefined, '0.7.0'],
    ['### Added\n- Feature', 'auto', '0.7.0'],
    ['### Changed\n- Change', 'auto', '0.7.0'],
    ['### Removed\n- Removal', 'auto', '0.7.0'],
    ['### Fixed\n- Fix', undefined, '0.6.3'],
    ['### Deprecated\n- Deprecation', 'auto', '0.6.3'],
    ['### Added\n- Feature', 'minor', '0.7.0'],
    ['### Added\n- Feature', 'major', '1.0.0'],
    ['### Fixed\n- Fix', 'patch', '0.6.3'],
    ['### Fixed\n- Fix', 'minor', '0.7.0'],
    ['### Fixed\n- Fix', 'major', '1.0.0'],
  ])('%j with bump %s gives %s', async (section, bump, expected) => {
    await expect(define(section, bump)).resolves.toBe(expected);
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it.each([
    ['### Added\n- Feature', 'patch'],
    ['### Changed\n- Change', 'patch'],
  ])('fails for %j with the lower bump %s', async (section, bump) => {
    await expect(define(section, bump)).resolves.toBeUndefined();
    expect(core.setFailed).toHaveBeenCalledTimes(1);
  });

  it('fails without unreleased entries, also with a bump', async () => {
    await expect(define('', 'major')).resolves.toBeUndefined();
    expect(core.error).toHaveBeenCalledWith('No valid entries to release', expect.anything());
  });
});
