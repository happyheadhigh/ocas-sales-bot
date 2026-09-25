'use strict';
/* jv: "There has been some trades on Gondi with argonauts already... I would
   love that integrated into traitview and also integrate Gondi into future
   collections as well."
   The existing lib/gondi-sync.js uses the SDK's gondi.listings() -- which,
   per the SDK's own types, returns LOAN listings (desiredDuration /
   desiredPrincipalAddress: owners asking to borrow against an NFT), not
   sale listings. That's why every synced "listing" had no price. Gondi's
   GraphQL API (the SDK bundles its full schema) has the real endpoints,
   just not wrapped by the SDK's helpers:
     listListingsForSale(collectionId, statuses, hidden, first, after)
       -> OrderConnection (price, currencyAddress, maker, expiration, isAsk,
          hidden/isPrivate so Off-Market private listings can be skipped)
     listSales(collections, fromTimestamp, first, after)
       -> SaleConnection (price, currencyAddress, sender=seller,
          receiver=buyer, timestamp, txHash, marketPlace)
   Plain read-only POSTs, no SDK / wallet / sign-in (Gondi's own site shows
   both to logged-out visitors). Signatures copied from the bundled schema. */
const fetch = require('node-fetch');

const GONDI_GQL = 'https://api2.gondi.xyz/lending/graphql';

// Every request is time-limited: a slow/unresponsive Gondi must fail fast
// instead of hanging the caller (jv: the probe page got "stuck loading").
const GONDI_TIMEOUT_MS = 15_000;

async function gondiGql(operationName, query, variables){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GONDI_TIMEOUT_MS);
  let r, text;
  try{
    r = await fetch(`${GONDI_GQL}?operation=${encodeURIComponent(operationName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ operationName, query, variables }),
      signal: ctrl.signal,
    });
    text = await r.text();
  }catch(e){
    throw new Error(e.name === 'AbortError' ? `Gondi ${operationName}: no response within ${GONDI_TIMEOUT_MS/1000}s` : `Gondi ${operationName}: ${e.message}`);
  }finally{ clearTimeout(timer); }
  let body; try{ body = JSON.parse(text); }catch(_){ throw new Error(`Gondi ${operationName} HTTP ${r.status}: non-JSON (${text.slice(0,160)})`); }
  if(body.errors && body.errors.length) throw new Error(`Gondi ${operationName}: ${body.errors.map(e => e.message).join('; ').slice(0,300)}`);
  if(!r.ok) throw new Error(`Gondi ${operationName} HTTP ${r.status}`);
  return body.data;
}

const NFT_FIELDS = `nft { id tokenId collection { id slug contractData { contractAddress } } }`;

const Q_COLLECTIONS_BY_CONTRACT = `query CollectionsByContract($contractAddress: Address!) {
  getCollectionsByContractAddress(contractAddress: $contractAddress) { id slug name }
}`;

const Q_LISTINGS_FOR_SALE = `query ListListingsForSale($collectionId: Int, $first: Int, $after: String, $statuses: [OrderStatusType!], $hidden: Boolean) {
  listListingsForSale(collectionId: $collectionId, first: $first, after: $after, statuses: $statuses, hidden: $hidden) {
    totalCount
    pageInfo { hasNextPage endCursor }
    edges { node {
      id price currencyAddress isAsk hidden isPrivate status maker expiration marketPlace
      currency { symbol decimals }
      ... on SingleNFTOrder { ${NFT_FIELDS} }
    } }
  }
}`;

// listListingsForSale needs a single nft_id (probe: "Use nft_id + collection_id").
// Collection-wide asks come from listOrdersV2; Gondi's own marketplace is
// MarketPlaceType NATIVE (the enum has no Harbor -- Harbor isn't indexed).
const Q_ORDERS_V2 = `query ListOrdersV2($collectionIds: [Int!], $first: Int, $after: String, $statuses: [OrderStatusType!], $marketplaces: [MarketPlaceType!], $side: OrderSide, $hidden: Boolean) {
  listOrdersV2(collectionIds: $collectionIds, first: $first, after: $after, statuses: $statuses, marketplaces: $marketplaces, side: $side, hidden: $hidden) {
    totalCount
    pageInfo { hasNextPage endCursor }
    edges { node {
      id price currencyAddress isAsk hidden isPrivate status maker expiration marketPlace
      currency { symbol decimals }
      ... on SingleNFTOrder { ${NFT_FIELDS} }
    } }
  }
}`;

const Q_SALES = `query ListSales($collections: [Int!], $first: Int!, $after: String, $fromTimestamp: Int) {
  listSales(collections: $collections, first: $first, after: $after, fromTimestamp: $fromTimestamp) {
    totalCount
    pageInfo { hasNextPage endCursor }
    edges { node {
      id price currencyAddress marketPlace marketPlaceAddress sender receiver timestamp txHash
      ${NFT_FIELDS}
    } }
  }
}`;

// Collection activity by event type (trades, loan foreclosures/auctions...).
// TRADE_EXECUTED nodes are Deal records: NFTs + ERC20 amounts on each side.
const Q_EVENTS = `query ListEvents($collections: [Int!], $eventTypes: [EventType!], $first: Int!, $after: String, $fromTimestamp: Int) {
  listEvents(collections: $collections, eventTypes: $eventTypes, first: $first, after: $after, fromTimestamp: $fromTimestamp) {
    totalCount
    pageInfo { hasNextPage endCursor }
    edges { node {
      __typename
      ... on Deal { id status maker taker executedTxHash createdDate timestamp updatedDate
        makerNfts { tokenId collection { contractData { contractAddress } } } makerErc20s makerErc20sAmounts
        takerNfts { tokenId collection { contractData { contractAddress } } } takerErc20s takerErc20sAmounts }
      ... on LoanForeclosed { id txHash timestamp }
      ... on LoanAuctioned { id txHash timestamp totalAuctioned }
      ... on Sale { id txHash timestamp price marketPlace }
    } }
  }
}`;

async function gondiEventsPage(collectionId, eventTypes, after, first, fromTimestamp){
  const d = await gondiGql('ListEvents', Q_EVENTS,
    { collections: [collectionId], eventTypes, first: first || 50, after: after || null, fromTimestamp: fromTimestamp || null });
  return d.listEvents;
}

async function gondiCollectionIds(contractAddress){
  const d = await gondiGql('CollectionsByContract', Q_COLLECTIONS_BY_CONTRACT, { contractAddress });
  return (d?.getCollectionsByContractAddress || []).map(c => ({ id: parseInt(c.id, 10), slug: c.slug, name: c.name }));
}

async function gondiListingsForSalePage(collectionId, after){
  const d = await gondiGql('ListListingsForSale', Q_LISTINGS_FOR_SALE,
    { collectionId, first: 50, after: after || null, statuses: ['Active'], hidden: false });
  return d.listListingsForSale;
}

async function gondiAsksPage(collectionId, after, marketplaces){
  const d = await gondiGql('ListOrdersV2', Q_ORDERS_V2,
    { collectionIds: [collectionId], first: 50, after: after || null, statuses: ['Active'],
      marketplaces: marketplaces || null, side: 'ASK', hidden: false });
  return d.listOrdersV2;
}

async function gondiSalesPage(collectionId, fromTimestamp, after, first){
  const d = await gondiGql('ListSales', Q_SALES,
    { collections: [collectionId], first: first || 50, after: after || null, fromTimestamp: fromTimestamp || null });
  return d.listSales;
}

module.exports = { gondiGql, gondiCollectionIds, gondiListingsForSalePage, gondiAsksPage, gondiSalesPage, gondiEventsPage };
