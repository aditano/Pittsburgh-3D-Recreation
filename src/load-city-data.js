/**
 * The modelled downtown (pittsburgh.json) is required. Land cover, background
 * fabric, transit, storefronts, and street furniture are optional: a failed
 * fetch or a broken JSON file degrades that layer to its empty fallback
 * instead of aborting the city.
 */

export async function fetchOptionalJson(url, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(url);
    if (!response?.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function loadCityDatasets(urls, fetchImpl = globalThis.fetch) {
  const [cityRes, landcover, fabric, transit, businesses, streets] = await Promise.all([
    fetchImpl(urls.city),
    fetchOptionalJson(urls.landcover, fetchImpl),
    fetchOptionalJson(urls.fabric, fetchImpl),
    fetchOptionalJson(urls.transit, fetchImpl),
    fetchOptionalJson(urls.businesses, fetchImpl),
    fetchOptionalJson(urls.streets, fetchImpl),
  ]);
  if (!cityRes?.ok) {
    throw new Error(`Failed to load city data (${cityRes?.status ?? 'network'})`);
  }
  const city = await cityRes.json();
  return { city, landcover, fabric, transit, businesses, streets };
}
