// api/moments.js — Vercel Serverless Function
// Récupère les derniers listings Top Shot (Legendary, Rare, Ultimate + quelques Common)
// et les renvoie au jeu avec toutes les infos nécessaires.

const TOPSHOT_URL = 'https://nbatopshot.com/marketplace/graphql';

const QUERY = `
  query SearchMarketplaceListings(
    $byMomentTiers: [MomentTier] = [],
    $byHasAutograph: Boolean = null,
    $searchInput: BaseSearchInput = {pagination: {direction: RIGHT, limit: 40, cursor: ""}}
  ) {
    searchMarketplaceListings(input: {
      filters: {
        byMomentTiers: $byMomentTiers,
        byHasAutograph: $byHasAutograph,
        hideSold: false
      },
      sortBy: CREATED_AT_DESC,
      searchInput: $searchInput
    }) {
      data {
        searchSummary {
          data {
            data {
              ... on MarketplaceListingSearchResult {
                price
                tier
                assetPathPrefix
                moment { id flowSerialNumber }
                set { flowName }
                play { stats { playerName teamAtMoment playCategory } }
                setPlay {
                  tags { title }
                  circulations { circulationCount }
                }
                marketplaceStats { price averageSalePrice highestOffer }
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
  'Referer':            'https://nbatopshot.com/search/live',
  'User-Agent':         'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language':    'en-US,en;q=0.9',
  'sec-fetch-dest':     'empty',
  'sec-fetch-mode':     'cors',
  'sec-fetch-site':     'same-origin',
};

// Normalise un résultat brut en objet utilisable par le jeu
function normalize(item) {
  const stats = item.play?.stats ?? {};
  const tags  = (item.setPlay?.tags ?? []).map(t => t.title.toLowerCase());

  const scarcity =
    item.tier === 'MOMENT_TIER_LEGENDARY' ? 'legendary' :
    item.tier === 'MOMENT_TIER_RARE'      ? 'rare'      :
    item.tier === 'MOMENT_TIER_ULTIMATE'  ? 'ultimate'  :
    item.tier === 'MOMENT_TIER_FANDOM'    ? 'fandom'    : 'common';

  const hasAutograph = tags.some(t => t.includes('autograph'));

  return {
    id:           item.moment?.id ?? '',
    player:       stats.playerName    ?? 'Unknown',
    team:         stats.teamAtMoment  ?? '',
    play:         stats.playCategory  ?? '',
    set:          item.set?.flowName  ?? '',
    serial:       parseInt(item.moment?.flowSerialNumber) || 0,
    circ:         item.setPlay?.circulations?.circulationCount ?? 0,
    scarcity,
    hasAutograph,
    // Prix de ce serial précis — c'est la réponse correcte du jeu
    lowestAsk:    Math.round(parseFloat(item.price)) || 0,
    // Prix de l'édition (lowest ask global) — info contextuelle
    editionAsk:   Math.round(parseFloat(item.marketplaceStats?.price)) || 0,
    avgSale:      Math.round(parseFloat(item.marketplaceStats?.averageSalePrice)) || 0,
    imageUrl:     item.assetPathPrefix
                    ? `${item.assetPathPrefix}Hero_2880_2880_Black.jpg?format=webp&quality=80&width=512`
                    : null,
    momentUrl:    `https://nbatopshot.com/moment/${item.moment?.id ?? ''}`,
  };
}

async function fetchTier(tiers, hasAutograph = null, limit = 40) {
  const variables = {
    byMomentTiers: tiers,
    byHasAutograph: hasAutograph,
    searchInput: { pagination: { direction: 'RIGHT', cursor: '', limit } },
  };

  const res = await fetch(TOPSHOT_URL, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ operationName: 'SearchMarketplaceListings', query: QUERY, variables }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`TopShot ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  const raw  = json?.data?.searchMarketplaceListings?.data?.searchSummary?.data?.data ?? [];
  return raw.map(normalize).filter(m => m.lowestAsk > 0 && m.player !== 'Unknown');
}

// Mélange un tableau (Fisher-Yates)
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    // Appel principal : Legendary + Rare + Ultimate
    const premium = await fetchTier(
      ['MOMENT_TIER_LEGENDARY', 'MOMENT_TIER_RARE', 'MOMENT_TIER_ULTIMATE'],
      null,
      40
    );

    // Quelques Common pour surprendre (~2 par partie)
    let commons = [];
    try {
      commons = await fetchTier(['MOMENT_TIER_COMMON'], null, 10);
      // On ne garde que les commons avec un prix un peu intéressant (> $2)
      commons = commons.filter(m => m.lowestAsk > 2).slice(0, 4);
    } catch(e) {
      console.warn('Common fetch failed, skipping:', e.message);
    }

    // Pool final : premium + quelques commons mélangés
    const pool = shuffle([...premium, ...commons]);

    // On retourne 30 Moments max — le jeu en tire 10 au hasard côté client
    const moments = pool.slice(0, 30);

    if (moments.length < 10) {
      return res.status(502).json({ error: 'Not enough moments', count: moments.length });
    }

    // Cache 3 minutes — données fraîches sans surcharger l'API
    res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=60');
    return res.status(200).json({ moments });

  } catch (err) {
    console.error('Proxy error:', err.message);
    return res.status(502).json({ error: err.message });
  }
}
