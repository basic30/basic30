const fs = require("fs");

const TOKEN = process.env.GITHUB_TOKEN;
const USERNAME = process.env.GITHUB_USERNAME || "basic30";

if (!TOKEN) {
  throw new Error("GITHUB_TOKEN is missing.");
}

/*
 * We request a long enough period to calculate:
 *
 * - Total contributions
 * - Current streak
 * - Longest streak
 * - Longest streak start/end dates
 * - First contribution date
 *
 * GitHub's contribution calendar provides the individual
 * contribution days we need.
 */

const query = `
query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays {
            date
            contributionCount
          }
        }
      }
    }
  }
}
`;

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function utcDate(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDate(dateString) {
  const date = utcDate(dateString);

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  });
}

function formatShortDate(dateString) {
  const date = utcDate(dateString);

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  });
}

async function githubGraphQL() {
  const today = new Date();

  // GitHub allows a maximum of 1 year per
  // contributionsCollection query.
  //
  // We use 364-day chunks to stay safely below
  // GitHub's one-year limit.

  const allDays = [];

  let cursor = new Date(Date.UTC(2021, 0, 1));

  while (cursor <= today) {
    const from = new Date(cursor);

    const to = new Date(cursor);
    to.setUTCDate(to.getUTCDate() + 364);

    // Never request beyond today.
    if (to > today) {
      to.setTime(today.getTime());
    }

    console.log(
      `Fetching ${dateOnly(from)} → ${dateOnly(to)}`
    );

    const query = `
      query(
        $login: String!,
        $from: DateTime!,
        $to: DateTime!
      ) {
        user(login: $login) {
          contributionsCollection(
            from: $from,
            to: $to
          ) {
            contributionCalendar {
              totalContributions

              weeks {
                contributionDays {
                  date
                  contributionCount
                }
              }
            }
          }
        }
      }
    `;

    const response = await fetch(
      "https://api.github.com/graphql",
      {
        method: "POST",

        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          "User-Agent": "basic30-streak-generator"
        },

        body: JSON.stringify({
          query,

          variables: {
            login: USERNAME,
            from: from.toISOString(),
            to: to.toISOString()
          }
        })
      }
    );

    if (!response.ok) {
      throw new Error(
        `GitHub API returned HTTP ${response.status}`
      );
    }

    const result = await response.json();

    if (result.errors) {
      console.error(result.errors);
      throw new Error(
        "GitHub GraphQL request failed."
      );
    }

    if (!result.data?.user) {
      throw new Error(
        `GitHub user "${USERNAME}" was not found.`
      );
    }

    const calendar =
      result.data.user.contributionsCollection
        .contributionCalendar;

    for (const week of calendar.weeks) {
      for (const day of week.contributionDays) {
        allDays.push(day);
      }
    }

    // Move to the next day after this chunk.
    cursor = new Date(to);
    cursor.setUTCDate(
      cursor.getUTCDate() + 1
    );
  }

  /*
   * Remove duplicate dates.
   *
   * This protects us if GitHub's calendar alignment
   * returns an overlapping day between chunks.
   */

  const uniqueDays = new Map();

  for (const day of allDays) {
    uniqueDays.set(day.date, day);
  }

  return {
    weeks: [
      {
        contributionDays:
          Array.from(uniqueDays.values())
      }
    ]
  };
}


/*
 * Calculate all streak information.
 */
function calculateStats(days) {
  const sorted = [...days].sort(
    (a, b) => a.date.localeCompare(b.date)
  );

  /*
   * Remove duplicate dates just in case the API ever
   * returns overlapping calendar ranges.
   */
  const unique = [];

  const seen = new Set();

  for (const day of sorted) {
    if (!seen.has(day.date)) {
      seen.add(day.date);
      unique.push(day);
    }
  }

  /*
   * First contribution.
   */
  const firstContribution = unique.find(
    day => day.contributionCount > 0
  );

  /*
   * -------------------------
   * LONGEST STREAK
   * -------------------------
   */

  let longestLength = 0;
  let longestStart = null;
  let longestEnd = null;

  let runningLength = 0;
  let runningStart = null;
  let previousDate = null;

  for (const day of unique) {
    const count = day.contributionCount;

    if (count > 0) {
      const currentDate = utcDate(day.date);

      const isConsecutive =
        previousDate &&
        currentDate.getTime() - previousDate.getTime() ===
          24 * 60 * 60 * 1000;

      if (!isConsecutive) {
        runningLength = 1;
        runningStart = day.date;
      } else {
        runningLength++;
      }

      if (runningLength > longestLength) {
        longestLength = runningLength;
        longestStart = runningStart;
        longestEnd = day.date;
      }

      previousDate = currentDate;
    } else {
      runningLength = 0;
      runningStart = null;
      previousDate = null;
    }
  }

  /*
   * -------------------------
   * CURRENT STREAK
   * -------------------------
   *
   * A current streak exists only if today has a contribution.
   *
   * This matches the visual behavior we want:
   *
   * Today = 0 contribution
   * → Current Streak = 0
   */

const today = new Date();

today.setUTCHours(0, 0, 0, 0);

const todayString = dateOnly(today);

const contributionMap = new Map(
  unique.map(day => [
    day.date,
    day.contributionCount
  ])
);

let currentStreak = 0;

/*
 * Match GitHub Readme Streak Stats:
 *
 * If today has a contribution:
 *     start from today.
 *
 * If today has NO contribution:
 *     start from yesterday.
 *
 * This means an unfinished streak does NOT
 * immediately become zero.
 */

let cursor;

if ((contributionMap.get(todayString) || 0) > 0) {

  // Today counts
  cursor = new Date(today);

} else {

  // Today doesn't count.
  // Continue from yesterday.
  cursor = new Date(today);

  cursor.setUTCDate(
    cursor.getUTCDate() - 1
  );
}

while (true) {

  const key = dateOnly(cursor);

  const contributions =
    contributionMap.get(key) || 0;

  if (contributions <= 0) {
    break;
  }

  currentStreak++;

  cursor.setUTCDate(
    cursor.getUTCDate() - 1
  );
}
  /*
   * Date shown below Current Streak.
   *
   * The screenshot shows today's date.
   */
  const currentDateLabel = formatShortDate(todayString);

  return {
    totalContributions: unique.reduce(
      (sum, day) => sum + day.contributionCount,
      0
    ),

    currentStreak,

    longestStreak: longestLength,

    firstContributionDate:
      firstContribution?.date || null,

    longestStart,

    longestEnd,

    currentDateLabel
  };
}


/*
 * Escape values before putting them into SVG.
 */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}


/*
 * EXACT CARD DESIGN
 */
function generateSVG(stats) {

  const total = stats.totalContributions
    .toLocaleString("en-US");

  const current = stats.currentStreak;

  const longest = stats.longestStreak;

  /*
   * Left date
   */
  let firstDateText = "No contributions";

  if (stats.firstContributionDate) {
    firstDateText =
      `${formatDate(stats.firstContributionDate)} - Present`;
  }

  /*
   * Longest streak date.
   */
  let longestDateText = "No streak";

  if (
    stats.longestStart &&
    stats.longestEnd
  ) {
    longestDateText =
      `${formatDate(stats.longestStart)} - ${formatDate(stats.longestEnd)}`;
  }

  return `
<svg
  width="620"
  height="245"
  viewBox="0 0 620 245"
  fill="none"
  xmlns="http://www.w3.org/2000/svg"
>

  <!-- CARD -->

  <rect
    x="1"
    y="1"
    width="618"
    height="243"
    rx="6"
    fill="#0D1117"
    stroke="#30363D"
  />


  <!-- ========================= -->
  <!-- VERTICAL SEPARATORS -->
  <!-- ========================= -->

  <line
    x1="206"
    y1="34"
    x2="206"
    y2="213"
    stroke="#8B949E"
    stroke-width="1"
  />

  <line
    x1="413"
    y1="34"
    x2="413"
    y2="213"
    stroke="#8B949E"
    stroke-width="1"
  />


  <!-- ========================= -->
  <!-- LEFT: TOTAL CONTRIBUTIONS -->
  <!-- ========================= -->

  <text
    x="103"
    y="100"
    text-anchor="middle"
    fill="#FFFFFF"
    font-family="Arial, Helvetica, sans-serif"
    font-size="36"
    font-weight="700"
  >
    ${escapeXml(total)}
  </text>

  <text
    x="103"
    y="145"
    text-anchor="middle"
    fill="#B084FF"
    font-family="Arial, Helvetica, sans-serif"
    font-size="17"
    font-weight="400"
  >
    Total Contributions
  </text>

  <text
    x="103"
    y="183"
    text-anchor="middle"
    fill="#AAAAAA"
    font-family="Arial, Helvetica, sans-serif"
    font-size="14"
    font-weight="400"
  >
    ${escapeXml(firstDateText)}
  </text>


  <!-- ========================= -->
  <!-- CENTER: CURRENT STREAK -->
  <!-- ========================= -->

  <circle
    cx="310"
    cy="89"
    r="50"
    stroke="#B084FF"
    stroke-width="7"
    fill="none"
  />


  <!-- Pink flame -->

  <path
    d="
      M310 31
      C302 38 300 43 304 48
      C306 50 307 52 307 55
      C307 58 309 60 312 60
      C317 60 320 56 320 51
      C320 45 316 39 310 31
      Z
    "
    fill="#FF77D8"
  />

  <path
    d="
      M310 38
      C307 43 308 46 311 49
      C313 51 313 54 311 56
      C315 55 317 52 316 49
      C315 45 313 42 310 38
      Z
    "
    fill="#0D1117"
  />


  <!-- Current streak number -->

  <text
    x="310"
    y="100"
    text-anchor="middle"
    fill="#FFFFFF"
    font-family="Arial, Helvetica, sans-serif"
    font-size="34"
    font-weight="700"
  >
    ${current}
  </text>


  <!-- Current streak label -->

  <text
    x="310"
    y="175"
    text-anchor="middle"
    fill="#5DE4FF"
    font-family="Arial, Helvetica, sans-serif"
    font-size="18"
    font-weight="700"
  >
    Current Streak
  </text>


  <!-- Current date -->

  <text
    x="310"
    y="207"
    text-anchor="middle"
    fill="#AAAAAA"
    font-family="Arial, Helvetica, sans-serif"
    font-size="14"
    font-weight="400"
  >
    ${escapeXml(stats.currentDateLabel)}
  </text>


  <!-- ========================= -->
  <!-- RIGHT: LONGEST STREAK -->
  <!-- ========================= -->

  <text
    x="516"
    y="100"
    text-anchor="middle"
    fill="#FFFFFF"
    font-family="Arial, Helvetica, sans-serif"
    font-size="36"
    font-weight="700"
  >
    ${longest}
  </text>

  <text
    x="516"
    y="145"
    text-anchor="middle"
    fill="#B084FF"
    font-family="Arial, Helvetica, sans-serif"
    font-size="17"
    font-weight="400"
  >
    Longest Streak
  </text>

  <text
    x="516"
    y="183"
    text-anchor="middle"
    fill="#AAAAAA"
    font-family="Arial, Helvetica, sans-serif"
    font-size="14"
    font-weight="400"
  >
    ${escapeXml(longestDateText)}
  </text>

</svg>
`;
}


async function main() {

  console.log(
    `Fetching GitHub contributions for ${USERNAME}...`
  );

  const calendar =
    await githubGraphQL();

  const days =
    calendar.weeks.flatMap(
      week => week.contributionDays
    );

  const stats =
    calculateStats(days);

  console.log(
    `Total contributions: ${stats.totalContributions}`
  );

  console.log(
    `Current streak: ${stats.currentStreak}`
  );

  console.log(
    `Longest streak: ${stats.longestStreak}`
  );

  console.log(
    `First contribution: ${stats.firstContributionDate}`
  );

  console.log(
    `Longest streak: ${stats.longestStart} → ${stats.longestEnd}`
  );

  const svg =
    generateSVG(stats);

  fs.writeFileSync(
    "streak.svg",
    svg,
    "utf8"
  );

  console.log(
    "Successfully generated streak.svg"
  );
}

main().catch(error => {

  console.error(error);

  process.exit(1);
});
