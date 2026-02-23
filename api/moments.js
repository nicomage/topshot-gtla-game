// api/moments.js — Vercel Serverless Function
// Utilise searchMarketplaceTransactions (prix validés = vrais achats)
// Filtre côté proxy : Legendary/Rare/Ultimate toujours, Commons si prix > $10

const TOPSHOT_URL = 'https://nbatopshot.com/marketplace/graphql';

const QUERY = `
  query SearchMarketplaceTransactions($input: SearchMarketplaceTransactionsInput!) {
    searchMarketplaceTransactions(input: $input) {
      data {
        searchSummary {
          data {
            ... on MarketplaceTransactions {
              data {
                ... on MarketplaceTransaction {
                  price
                  moment {
                    id
                    flowSerialNumber
                    tier
                    assetPathPrefix
                    set { flowName }
                    play { stats { playerName teamAtMoment playCategory } }
                    setPlay { circulations { circulationCount } }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const HEADERS = {
  'Content-Type':       'application/json',
  'Accept':             '*/*',
  'Origin':             'https://nbatopshot.com',
  'Referer':            'https://nbatopshot.com/transactions',
  'User-Agent':         'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language':    'en-US,en;q=0.9',
  'sec-fetch-dest':     'empty',
  'sec-fetch-mode':     'cors',
  'sec-fetch-site':     'same-origin',
};

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function normalize(item) {
  const m     = item.moment;
  const stats = m.play?.stats ?? {};

  const scarcity =
    m.tier === 'MOMENT_TIER_LEGENDARY' ? 'legendary' :
    m.tier === 'MOMENT_TIER_RARE'      ? 'rare'      :
    m.tier === 'MOMENT_TIER_ULTIMATE'  ? 'ultimate'  :
    m.tier === 'MOMENT_TIER_FANDOM'    ? 'fandom'    : 'common';

  return {
    id:        m.id,
    player:    stats.playerName    ?? 'Unknown',
    team:      stats.teamAtMoment  ?? '',
    play:      stats.playCategory  ?? '',
    set:       m.set?.flowName     ?? '',
    serial:    parseInt(m.flowSerialNumber) || 0,
    circ:      m.setPlay?.circulations?.circulationCount ?? 0,
    scarcity,
    lowestAsk: Math.round(parseFloat(item.price)) || 0,
    imageUrl:  m.assetPathPrefix
                 ? `${m.assetPathPrefix}Hero_2880_2880_Black.jpg?format=webp&quality=80&width=512`
                 : null,
    momentUrl: `https://nbatopshot.com/moment/${m.id}`,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const response = await fetch(TOPSHOT_URL, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        query: QUERY,
        variables: {
          input: {
            sortBy: 'UPDATED_AT_DESC',
            filters: { byParallels: [] },
            searchInput: { pagination: { cursor: '', direction: 'RIGHT', limit: 200 } },
          },
        },
      }),
    });

    const bodyText = await response.text();

    if (!response.ok) {
      console.error('TopShot error', response.status, bodyText.slice(0, 300));
      return res.status(502).json({ error: `TopShot ${response.status}`, body: bodyText.slice(0, 300) });
    }

    const json = await response.json();
    const raw  = json?.data?.searchMarketplaceTransactions?.data?.searchSummary?.data?.data ?? [];

    const all = raw
      .filter(item => item.moment && item.price)
      .map(normalize)
      .filter(m => m.lowestAsk > 0 && m.player !== 'Unknown');

    // Premium : Legendary, Rare, Ultimate — toujours inclus
    const premium = all.filter(m => ['legendary', 'rare', 'ultimate'].includes(m.scarcity));

    // Commons surprises : seulement si prix > $10 (évite les $1-2 sans intérêt)
    const interestingCommons = all
      .filter(m => m.scarcity === 'common' && m.lowestAsk > 10)
      .slice(0, 6);

    // Fandom : on les garde s'il y en a
    const fandom = all.filter(m => m.scarcity === 'fandom');

    // Dédupliquer par player+set
    const seen = new Set();
    const deduped = [...premium, ...fandom, ...interestingCommons].filter(m => {
      const key = `${m.player}-${m.set}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const moments = shuffle(deduped).slice(0, 40);

    if (moments.length < 5) {
      return res.status(502).json({ error: 'Not enough moments', count: moments.length });
    }

    // Cache 3 minutes
    res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=60');
    return res.status(200).json({ moments, total: moments.length });

  } catch (err) {
    console.error('Proxy error:', err.message);
    return res.status(502).json({ error: err.message });
  }
}
