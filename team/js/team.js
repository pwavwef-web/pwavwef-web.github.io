/**
 * AZ Learner – Team Page Script
 * Fetches team-data.json and dynamically renders profile cards.
 */

(function () {
  'use strict';

  /* ---- DOM target ---- */
  const grid = document.getElementById('team-grid');

  if (!grid) return; // Guard: only run on the team index page

  /**
   * Build the HTML for a single profile card.
   * @param {Object} member - Team member object from JSON
   * @returns {string} HTML string
   */
  function buildCard(member) {
    const {
      name = 'Team Member',
      role = '',
      image = 'assets/images/placeholder.svg',
      bio = '',
      profile = '#',
    } = member;

    return `
      <article class="profile-card" aria-label="Profile card for ${escapeHtml(name)}">
        <div class="card-accent"></div>
        <div class="card-image-wrap">
          <img
            class="card-image"
            src="${escapeHtml(image)}"
            alt="Photo of ${escapeHtml(name)}"
            loading="lazy"
            onerror="this.src='assets/images/placeholder.svg'"
          />
        </div>
        <div class="card-body">
          <h2 class="card-name">${escapeHtml(name)}</h2>
          <p class="card-role">${escapeHtml(role)}</p>
          <p class="card-bio">${escapeHtml(bio)}</p>
          <a class="btn-view-profile" href="${escapeHtml(profile)}">View Profile</a>
        </div>
      </article>
    `;
  }

  /**
   * Render team members into the grid.
   * @param {Array} team - Array of team member objects
   */
  function renderTeam(team) {
    if (!Array.isArray(team) || team.length === 0) {
      grid.innerHTML = '<p class="team-error">No team members found.</p>';
      return;
    }

    grid.innerHTML = team.map(buildCard).join('');
  }

  /**
   * Show a loading spinner while data is being fetched.
   */
  function showLoading() {
    grid.innerHTML = `
      <div class="team-loading" aria-live="polite">
        <div class="spinner" role="status" aria-label="Loading team members"></div>
        <p>Loading team members…</p>
      </div>
    `;
  }

  /**
   * Show an error message inside the grid.
   * @param {string} msg - Error message
   */
  function showError(msg) {
    grid.innerHTML = `<p class="team-error">${escapeHtml(msg)}</p>`;
  }

  /**
   * Escape special HTML characters to prevent XSS.
   * @param {string} str
   * @returns {string}
   */
  function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ---- Fetch and render ---- */
  showLoading();

  fetch('team-data.json')
    .then(function (response) {
      if (!response.ok) {
        throw new Error('Could not load team data (HTTP ' + response.status + ').');
      }
      return response.json();
    })
    .then(function (data) {
      renderTeam(data.team);
    })
    .catch(function (err) {
      console.error('[team.js] Failed to load team data:', err);
      showError('Unable to load team members. Please try again later.');
    });
})();
