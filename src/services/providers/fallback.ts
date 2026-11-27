import type {
  DealerProduct,
  DealerProvider,
  DealerSearchQuery,
  DealerStockist,
  DealerSummary,
  ProductHit,
  ProductSearchQuery,
  Sourced,
  StockistQuery,
} from '../types';

/**
 * Two shop systems behind one list.
 *
 * The app has always had two places shops can come from, and until now it picked
 * one at boot: the AgriShop marketplace when its key was configured, otherwise the
 * app's own dealer projection (`dealers_within_radius` and friends). That choice
 * looked harmless and was not. The dealer projection is where the shops this app
 * actually knows are recorded — the same table the scan screen's stockist list
 * reads — so a build that preferred the marketplace showed a farmer two different
 * sets of shops depending on which screen they were on, and showed *none* when the
 * marketplace project held no listings near them while their own shops sat in the
 * database the whole time.
 *
 * So the sources are asked in order, and the first one that actually has something
 * to say wins. Concretely:
 *
 *   · a source that answers with rows wins immediately, and the answer keeps its
 *     own `sourceLabel` — the screen keeps saying which system spoke;
 *   · a source that answers with *no* rows does not win, because "this system has
 *     never heard of a shop near you" is not the same claim as "there is no shop
 *     near you", and the next source may hold the shops this one does not;
 *   · a source that fails does not win either, and a later success is preferred to
 *     an earlier failure — a shop the farmer can walk to beats a truthful error;
 *   · if every source is empty, the empty answer is returned as it was reported,
 *     so the screen still says "no shop within 10 km" rather than inventing one;
 *   · if every source failed, the first failure is returned, with its own error.
 *
 * Reading is the only thing chained. Writes (a chat message, a stock update) go to
 * the shop's own system and are not this class's business.
 */
export class ChainedDealerProvider implements DealerProvider {
  readonly maxRadiusKm = 150 as const;

  /** Names every source it consulted, so a report can say what was tried. */
  readonly name: string;

  constructor(private readonly sources: readonly DealerProvider[]) {
    if (sources.length === 0) throw new Error('A dealer chain needs at least one source.');
    this.name = sources.map((source) => source.name).join(' or ');
  }

  search(query: DealerSearchQuery): Promise<Sourced<DealerSummary[]>> {
    return this.firstAnswer((source) => source.search(query));
  }

  products(dealerId: string): Promise<Sourced<DealerProduct[]>> {
    return this.firstAnswer((source) => source.products(dealerId));
  }

  stockists(query: StockistQuery): Promise<Sourced<DealerStockist[]>> {
    return this.firstAnswer((source) => source.stockists(query));
  }

  searchProducts(query: ProductSearchQuery): Promise<Sourced<ProductHit[]>> {
    return this.firstAnswer((source) => source.searchProducts(query));
  }

  /**
   * The one rule, in one place. Generic over what is being read, because all four
   * reads answer the same question: which source knows anything about this.
   */
  private async firstAnswer<T>(
    read: (source: DealerProvider) => Promise<Sourced<T[]>>,
  ): Promise<Sourced<T[]>> {
    let empty: Sourced<T[]> | null = null;
    let failure: Sourced<T[]> | null = null;

    for (const source of this.sources) {
      let answer: Sourced<T[]>;
      try {
        answer = await read(source);
      } catch (thrown) {
        /* A provider that throws instead of reporting is still a provider that did
           not answer; the chain treats it the same way rather than letting one
           broken source take the list down with it. */
        answer = {
          data: [],
          sourceLabel: source.name,
          observedAt: Date.now(),
          fetchedAt: Date.now(),
          freshness: 'unavailable',
          status: 'failing',
          error: thrown instanceof Error ? thrown.message : 'The shop source could not be reached.',
        };
      }

      if (answer.status !== 'failing' && answer.data.length > 0) return answer;
      if (answer.status === 'failing') failure ??= answer;
      else empty ??= answer;
    }

    if (empty) return empty;
    if (failure) return failure;

    /* Unreachable for a non-empty chain, kept so the return type is honest. */
    return {
      data: [],
      sourceLabel: this.name,
      observedAt: Date.now(),
      fetchedAt: Date.now(),
      freshness: 'unavailable',
      status: 'failing',
      error: 'No shop source answered.',
    };
  }
}
