/**
 * AZ Learner – Team Profile Form Script
 * Provides live preview and generates JSON + HTML output
 * for the team admin to publish a new member's profile.
 */

(function () {
  'use strict';

  /* ---- Grab form & preview elements ---- */
  var form       = document.getElementById('profile-form');
  var output     = document.getElementById('pf-output');
  var outputJson = document.getElementById('output-json');
  var outputHtml = document.getElementById('output-html');

  /* Live-preview elements */
  var previewImg  = document.getElementById('preview-img');
  var previewName = document.getElementById('preview-name');
  var previewRole = document.getElementById('preview-role');
  var previewBio  = document.getElementById('preview-bio');

  if (!form) return; // Guard: only run on profile-form.html

  /* ---- Helpers ---- */

  /**
   * Escape HTML special characters (XSS prevention).
   * @param {string} str
   * @returns {string}
   */
  function esc(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Convert a name like "Francis Pwavwe" to a slug: "francis-pwavwe".
   * @param {string} name
   * @returns {string}
   */
  function slugify(name) {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-');
  }

  /**
   * Parse comma-separated skills into a trimmed array, ignoring empties.
   * @param {string} raw
   * @returns {string[]}
   */
  function parseSkills(raw) {
    if (!raw || !raw.trim()) return [];
    return raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  /**
   * Read and return the current form values.
   * @returns {Object}
   */
  function readForm() {
    return {
      name:     form.elements['name'].value.trim(),
      role:     form.elements['role'].value.trim(),
      bio:      form.elements['bio'].value.trim(),
      skills:   parseSkills(form.elements['skills'].value),
      image:    form.elements['image'].value.trim() || 'assets/images/placeholder.svg',
      github:   form.elements['github'].value.trim(),
      linkedin: form.elements['linkedin'].value.trim(),
      twitter:  form.elements['twitter'].value.trim(),
    };
  }

  /* ---- Live preview ---- */

  function updatePreview() {
    var d = readForm();

    previewImg.src = d.image || 'assets/images/placeholder.svg';
    previewImg.alt = d.name ? 'Photo of ' + d.name : 'Preview photo';
    previewImg.onerror = function () { this.src = 'assets/images/placeholder.svg'; };

    previewName.textContent = d.name || 'Your Name';
    previewRole.textContent = d.role || 'Your Role';
    previewBio.textContent  = d.bio  || 'Your bio will appear here once you start filling in the form.';
  }

  /* Attach live-preview listeners */
  ['name', 'role', 'bio', 'image'].forEach(function (fieldName) {
    var el = form.elements[fieldName];
    if (el) {
      el.addEventListener('input', updatePreview);
    }
  });

  /* ---- Validation ---- */

  function showError(fieldId, msg) {
    var errorEl = document.getElementById(fieldId + '-error');
    var inputEl = document.getElementById(fieldId);
    if (errorEl) errorEl.textContent = msg;
    if (inputEl) inputEl.classList.add('pf-input-error');
  }

  function clearError(fieldId) {
    var errorEl = document.getElementById(fieldId + '-error');
    var inputEl = document.getElementById(fieldId);
    if (errorEl) errorEl.textContent = '';
    if (inputEl) inputEl.classList.remove('pf-input-error');
  }

  function validate(d) {
    var valid = true;

    clearError('pf-name');
    clearError('pf-role');
    clearError('pf-bio');

    if (!d.name) {
      showError('pf-name', 'Please enter your full name.');
      valid = false;
    }
    if (!d.role) {
      showError('pf-role', 'Please enter your role or position.');
      valid = false;
    }
    if (!d.bio) {
      showError('pf-bio', 'Please write a short bio.');
      valid = false;
    }

    return valid;
  }

  /* ---- Generators ---- */

  /**
   * Generate the JSON entry for team-data.json.
   * @param {Object} d - Form data
   * @returns {string}
   */
  function buildJsonEntry(d) {
    var slug = slugify(d.name);
    var entry = {
      name:    d.name,
      role:    d.role,
      image:   d.image,
      bio:     d.bio,
      profile: 'profiles/' + slug + '.html',
      skills:  d.skills,
      socials: {
        github:   d.github,
        linkedin: d.linkedin,
        twitter:  d.twitter,
      },
    };
    return JSON.stringify(entry, null, 4);
  }

  /**
   * Generate a standalone profile HTML page.
   * @param {Object} d - Form data
   * @returns {string}
   */
  function buildProfileHtml(d) {
    var slug = slugify(d.name);
    var descriptionMeta = d.name + ' \u2013 ' + d.role + ' at AZ Learner.';

    var skillsHtml = d.skills.length
      ? d.skills.map(function (s) { return '            <li class="skill-tag">' + esc(s) + '</li>'; }).join('\n')
      : '            <li class="skill-tag">Coming soon</li>';

    function socialLink(type, url, label, iconPath) {
      var disabled = url ? '' : ' disabled';
      var href = url || '#';
      var ariaDisabled = url ? '' : ' aria-disabled="true"';
      return (
        '<li>\n' +
        '              <a\n' +
        '                class="social-link ' + type + disabled + '"\n' +
        '                href="' + esc(href) + '"\n' +
        '                target="_blank"\n' +
        '                rel="noopener noreferrer"\n' +
        '                aria-label="' + label + '"' + ariaDisabled + '\n' +
        '              >\n' +
        '                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="' + iconPath + '"/></svg>\n' +
        '                ' + label.split(' ')[0] + '\n' +
        '              </a>\n' +
        '            </li>'
      );
    }

    var githubIcon = 'M12 0C5.374 0 0 5.373 0 12c0 5.303 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z';
    var linkedinIcon = 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z';
    var twitterIcon = 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.737-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z';

    return [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="UTF-8" />',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      '  <meta name="description" content="' + esc(descriptionMeta) + '" />',
      '  <meta name="author" content="AZ Learner" />',
      '  <title>' + esc(d.name) + ' | AZ Learner Team</title>',
      '  <link rel="icon" type="image/png" href="../../favicon.png" />',
      '  <link rel="preconnect" href="https://fonts.googleapis.com" />',
      '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
      '  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;600;700;800&display=swap" rel="stylesheet" />',
      '  <link rel="stylesheet" href="../css/team.css" />',
      '</head>',
      '<body>',
      '',
      '  <div class="bg-animated" aria-hidden="true"></div>',
      '',
      '  <header class="site-header">',
      '    <div class="container header-inner">',
      '      <a class="site-logo" href="../../index.html">AZ LEARNER</a>',
      '      <nav class="header-nav" aria-label="Site navigation">',
      '        <a class="nav-back" href="../../index.html" aria-label="Back to AZ Learner home">',
      '          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z" clip-rule="evenodd"/></svg>',
      '          Home',
      '        </a>',
      '      </nav>',
      '    </div>',
      '  </header>',
      '',
      '  <main>',
      '    <div class="container">',
      '',
      '      <a class="btn-back" href="../index.html" aria-label="Back to team page">',
      '        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z" clip-rule="evenodd"/></svg>',
      '        Back to Team',
      '      </a>',
      '',
      '      <section class="profile-hero" aria-labelledby="profile-name">',
      '        <div class="profile-avatar-wrap">',
      '          <img',
      '            class="profile-avatar"',
      '            src="' + esc(d.image) + '"',
      '            alt="Photo of ' + esc(d.name) + '"',
      '            onerror="this.src=\'../assets/images/placeholder.svg\'"',
      '          />',
      '        </div>',
      '        <h1 id="profile-name" class="text-gradient">' + esc(d.name) + '</h1>',
      '        <span class="role-badge">' + esc(d.role) + '</span>',
      '      </section>',
      '',
      '      <div class="profile-content">',
      '',
      '        <div class="section-card full-width">',
      '          <h2>About</h2>',
      '          <p>' + esc(d.bio) + '</p>',
      '        </div>',
      '',
      '        <div class="section-card">',
      '          <h2>Skills</h2>',
      '          <ul class="skills-list" aria-label="Skills">',
      skillsHtml,
      '          </ul>',
      '        </div>',
      '',
      '        <div class="section-card">',
      '          <h2>Projects</h2>',
      '          <div class="projects-placeholder">',
      '            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2zM16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/></svg>',
      '            <p>Projects coming soon.</p>',
      '          </div>',
      '        </div>',
      '',
      '        <div class="section-card full-width">',
      '          <h2>Connect</h2>',
      '          <ul class="socials-list" aria-label="Social links">',
      '            ' + socialLink('github',   d.github,   'GitHub',    githubIcon),
      '            ' + socialLink('linkedin', d.linkedin, 'LinkedIn',  linkedinIcon),
      '            ' + socialLink('twitter',  d.twitter,  'Twitter / X', twitterIcon),
      '          </ul>',
      '        </div>',
      '',
      '      </div>',
      '    </div>',
      '  </main>',
      '',
      '  <footer class="site-footer">',
      '    <p>Built by the <a href="../../index.html">AZ Learner Team</a> &mdash; helping students learn smarter.</p>',
      '  </footer>',
      '',
      '</body>',
      '</html>',
    ].join('\n');
  }

  /* ---- Copy button ---- */

  var COPY_ICON_HTML =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">' +
    '<path d="M8 2a1 1 0 000 2h2a1 1 0 100-2H8z"/>' +
    '<path d="M3 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v6h-4.586l1.293-1.293a1 1 0 00-1.414-1.414l-3 3a1 1 0 000 1.414l3 3a1 1 0 001.414-1.414L10.414 13H15v3a2 2 0 01-2 2H5a2 2 0 01-2-2V5z"/>' +
    '</svg> Copy';

  function markCopied(btn) {
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(function () {
      btn.innerHTML = COPY_ICON_HTML;
      btn.classList.remove('copied');
    }, 2000);
  }

  function markCopyFailed(btn) {
    btn.textContent = 'Failed – select & copy manually';
    setTimeout(function () {
      btn.innerHTML = COPY_ICON_HTML;
    }, 3000);
  }

  function legacyCopy(content, btn) {
    var ta = document.createElement('textarea');
    ta.value = content;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var success = false;
    try { success = document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
    if (success) {
      markCopied(btn);
    } else {
      markCopyFailed(btn);
    }
  }

  function attachCopyButton(btnId, getContent) {
    var btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', function () {
      var content = getContent();
      if (!content) return;

      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(content).then(function () {
          markCopied(btn);
        }).catch(function () {
          legacyCopy(content, btn);
        });
      } else {
        legacyCopy(content, btn);
      }
    });
  }

  attachCopyButton('copy-json-btn', function () { return outputJson.textContent; });
  attachCopyButton('copy-html-btn', function () { return outputHtml.textContent; });

  /* ---- Form submit ---- */

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var d = readForm();
    if (!validate(d)) return;

    var jsonEntry = buildJsonEntry(d);
    var profileHtml = buildProfileHtml(d);

    outputJson.textContent = jsonEntry;
    outputHtml.textContent = profileHtml;

    output.hidden = false;
    output.classList.add('is-visible');
    output.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  /* ---- Clear errors on input ---- */

  ['pf-name', 'pf-role', 'pf-bio'].forEach(function (fieldId) {
    var el = document.getElementById(fieldId);
    if (el) {
      el.addEventListener('input', function () { clearError(fieldId); });
    }
  });

})();
