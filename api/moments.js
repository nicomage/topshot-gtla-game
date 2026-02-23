// api/moments.js — Vercel Serverless Function
// Ce fichier tourne côté serveur Vercel, pas dans le navigateur.
// Il fait l'appel à l'API Top Shot et renvoie les données au jeu.
// Cloudflare ne bloque pas les requêtes serveur-à-serveur.

const TOPSHOT_URL = 'https://nbatopshot.com/marketplace/graphql';

// On demande 30 Moments actifs sur le marketplace, triés aléatoirement.
// On récupère : nom joueur, équipe, set, play, serial, circulation, scarcity, prix, image, id.
const QUERY = `
  query SearchMomentListings {
    searchMomentListings(
      input: {
        filters: { byForSale: true }
        sortBy: LISTING_DATE_DESC
        pagination: { cursor: "", direction: RIGHT, limit: 50 }
      }
    ) {
      data {
        searchSummary {
          data {
            ... on MomentListings {
              size
              data {
                moment {
                  id
                  flowSerialNumber
                  set {
                    id
                    flowName
                    setVisualId
                  }
                  play {
                    id
                    description
                    stats {
                      playerName
                      teamAtMoment
                      playCategory
                    }
                  }
                  assetPathPrefix
                  circulationCount
                  setPlay {
                    id
                    flowRetired
                    tags {
                      title
                    }
                  }
                }
                lowestAsk
              }
            }
          }
        }
      }
    }
  }
`;

export default async function handler(req, res) {
  // CORS — autorise le jeu (même domaine Vercel) à appeler ce proxy
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const response = await fetch(TOPSHOT_URL, {
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Accept':         'application/json',
        // Headers qui font ressembler la requête à un vrai navigateur sur nbatopshot.com
        'Origin':         'https://nbatopshot.com',
        'Referer':        'https://nbatopshot.com/search',
        'User-Agent':     'TopShotGTLAGame/1.0 (contact: your@email.com)',
        'Accept-Language':'en-US,en;q=0.9',
      },
      body: JSON.stringify({ query: QUERY }),
    });

    if (!response.ok) {
      // Si Top Shot répond avec une erreur HTTP, on le remonte proprement
      return res.status(502).json({
        error: 'TopShot API error',
        status: response.status,
        hint: 'Cloudflare may be blocking — consider switching to curated data'
      });
    }

    const json = await response.json();

    // Extraire et normaliser les données
    const raw = json?.data?.searchMomentListings?.data?.searchSummary?.data?.data ?? [];

    // Filtrer : on garde uniquement les Moments avec un prix et une image
    const moments = raw
      .filter(item => item.lowestAsk && item.moment?.assetPathPrefix)
      .map(item => {
        const m = item.moment;
        const stats = m.play?.stats ?? {};
        // Détecter la scarcity via les tags
        const tags = (m.setPlay?.tags ?? []).map(t => t.title.toLowerCase());
        const scarcity =
          tags.includes('legendary') ? 'legendary' :
          tags.includes('rare')      ? 'rare'      :
          tags.includes('fandom')    ? 'fandom'    : 'common';

        return {
          id:         m.id,
          player:     stats.playerName    ?? 'Unknown',
          team:       stats.teamAtMoment  ?? '',
          play:       stats.playCategory  ?? m.play?.description ?? '',
          set:        m.set?.flowName     ?? '',
          serial:     parseInt(m.flowSerialNumber) || 0,
          circ:       m.circulationCount  ?? 0,
          scarcity,
          lowestAsk:  Math.round(parseFloat(item.lowestAsk)),
          // L'image principale du Moment (format jpg, résolution raisonnable)
          imageUrl:   `${m.assetPathPrefix}Hero_2880_2880_Black.jpg`,
          momentUrl:  `https://nbatopshot.com/moment/${m.id}`,
        };
      })
      // On veut de la variété de prix — on prend un mix de toutes les scarcities
      .slice(0, 30);

    // Cache 5 minutes — les prix ne changent pas à la seconde
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json({ moments });

  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: 'Internal proxy error', detail: err.message });
  }
}
