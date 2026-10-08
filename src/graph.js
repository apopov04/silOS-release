// In-memory graph over the vault's link table. One instance per CLI invocation;
// loaded from SQLite at construction, disposable after the query finishes.
//
// Per nodejs-expert's recommendation: hand-rolled Map/Set beats graphology at
// our scale (short-lived processes, ~100–10k nodes). No native deps.

export class VaultGraph {
  constructor(db) {
    this.adj = new Map();     // id -> Set<id>   (outbound edges)
    this.radj = new Map();    // id -> Set<id>   (inbound edges; backlinks)
    this.nodes = new Set();   // every known id

    const edges = db.prepare("SELECT source_id, target_id FROM links WHERE target_id IS NOT NULL").all();
    for (const { source_id, target_id } of edges) {
      this.nodes.add(source_id);
      this.nodes.add(target_id);
      if (!this.adj.has(source_id)) this.adj.set(source_id, new Set());
      if (!this.radj.has(target_id)) this.radj.set(target_id, new Set());
      this.adj.get(source_id).add(target_id);
      this.radj.get(target_id).add(source_id);
    }

    // Include notes that have no edges yet — look up every note id so orphans
    // still appear in the node set.
    const noteIds = db.prepare("SELECT id FROM notes").all();
    for (const { id } of noteIds) this.nodes.add(id);
  }

  // Spreading activation. Seed map: { id -> weight }. Propagate along edges
  // (both outbound and backlinks — treat graph as undirected for retrieval)
  // with per-hop decay. Return top-K by accumulated weight.
  spreadingActivation(seeds, { decay = 0.5, hops = 3, topK = 20 } = {}) {
    const acc = new Map(Object.entries(seeds).map(([k, v]) => [k, Number(v) || 0]));
    let frontier = new Map(acc);

    for (let h = 0; h < hops; h++) {
      const next = new Map();
      for (const [id, w] of frontier) {
        const nbrs = this.neighbors(id);
        if (nbrs.size === 0) continue;
        const propagated = w * decay;
        for (const n of nbrs) {
          next.set(n, (next.get(n) || 0) + propagated);
        }
      }
      // Merge frontier into accumulator
      for (const [id, w] of next) {
        acc.set(id, (acc.get(id) || 0) + w);
      }
      frontier = next;
      if (frontier.size === 0) break;
    }

    return [...acc.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([id, weight]) => ({ id, weight }));
  }

  // Standard power iteration. Returns Map<id, rank>. Suitable for precompute
  // in the indexer, not for per-query use.
  pageRank({ iterations = 25, damping = 0.85 } = {}) {
    const nodes = [...this.nodes];
    const N = nodes.length;
    if (N === 0) return new Map();

    // Out-degrees for normalization
    const outDeg = new Map();
    for (const id of nodes) outDeg.set(id, this.adj.get(id)?.size || 0);

    let ranks = new Map(nodes.map((id) => [id, 1 / N]));

    for (let iter = 0; iter < iterations; iter++) {
      const next = new Map(nodes.map((id) => [id, (1 - damping) / N]));

      // Dangling-node mass: nodes with no outbound edges redistribute uniformly
      let danglingMass = 0;
      for (const id of nodes) {
        if ((outDeg.get(id) || 0) === 0) danglingMass += ranks.get(id);
      }
      const danglingContrib = (damping * danglingMass) / N;
      for (const id of nodes) next.set(id, next.get(id) + danglingContrib);

      // Propagate rank along edges
      for (const [src, targets] of this.adj) {
        const srcRank = ranks.get(src) || 0;
        const deg = targets.size;
        if (deg === 0) continue;
        const share = (damping * srcRank) / deg;
        for (const tgt of targets) {
          next.set(tgt, (next.get(tgt) || 0) + share);
        }
      }

      ranks = next;
    }

    return ranks;
  }

  // Degree-in + degree-out for each node. Cheap.
  degrees() {
    const out = new Map();
    for (const id of this.nodes) {
      out.set(id, {
        in: this.radj.get(id)?.size || 0,
        out: this.adj.get(id)?.size || 0,
      });
    }
    return out;
  }

  // BFS outward from startId, up to k hops. Returns Set of ids (excludes start).
  kHopNeighbors(startId, k = 2) {
    const seen = new Set([startId]);
    const result = new Set();
    let frontier = new Set([startId]);
    for (let h = 0; h < k; h++) {
      const next = new Set();
      for (const id of frontier) {
        for (const n of this.neighbors(id)) {
          if (!seen.has(n)) {
            seen.add(n);
            result.add(n);
            next.add(n);
          }
        }
      }
      if (next.size === 0) break;
      frontier = next;
    }
    return result;
  }

  // Undirected shortest path by BFS. Returns array of ids [a, ..., b] or null.
  shortestPath(a, b) {
    if (a === b) return [a];
    const prev = new Map([[a, null]]);
    const queue = [a];
    while (queue.length > 0) {
      const id = queue.shift();
      for (const n of this.neighbors(id)) {
        if (prev.has(n)) continue;
        prev.set(n, id);
        if (n === b) {
          const path = [];
          let cur = n;
          while (cur !== null) {
            path.unshift(cur);
            cur = prev.get(cur);
          }
          return path;
        }
        queue.push(n);
      }
    }
    return null;
  }

  // Undirected neighbor union (outbound + inbound). Retrieval queries treat
  // the graph as undirected; the indexer stores direction for audit purposes.
  neighbors(id) {
    const out = this.adj.get(id);
    const inn = this.radj.get(id);
    if (!out && !inn) return new Set();
    if (!out) return inn;
    if (!inn) return out;
    return new Set([...out, ...inn]);
  }
}
