import os
import random
import asyncio
import aiohttp
import requests
from supabase import create_client, Client

# Supabase Configurations
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://vphfmrejzflnmcvjmgtu.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "sb_publishable_fgHKnLnNNwIN-yq9AlU5wA_5TBJfJP2")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# Use persistent HTTP connection pool for requests
session = requests.Session()

def fetch_overpass_stations():
    """Fetch raw station data from OSM Overpass API with session pooling."""
    ontario_bbox = "42.0,-83.5,46.5,-74.5"
    overpass_url = "https://overpass-api.de/api/interpreter"
    query = f"""
    [out:json][timeout:60];
    node["amenity"="fuel"]({ontario_bbox});
    out 1000;
    """
    try:
        response = session.post(overpass_url, data={'data': query}, timeout=65)
        response.raise_for_status()
        data = response.json()
        return data.get('elements', [])
    except Exception as e:
        print(f"Error fetching Overpass data: {e}")
        return []

async def fetch_real_price_mock_api(aio_session, osm_id, lat, lng):
    """Simulate async external price API lookup."""
    await asyncio.sleep(0.05)  # Simulate network latency
    # Return a realistic pseudo-random price based on ID seed (e.g. 175.9 to 189.9)
    base_price = 180.9
    offset = ((osm_id % 15) - 7) * 0.8
    return round(base_price + offset, 1)

async def populate_station_prices(stations):
    """Fetch prices concurrently using high concurrency semaphore and dict mapping."""
    semaphore = asyncio.Semaphore(30) # High concurrency limit
    valid_stations = [s for s in stations if s.get('lat') is not None and s.get('lon') is not None]
    
    price_map = {}

    async with aiohttp.ClientSession() as aio_session:
        async def worker(station):
            async with semaphore:
                osm_id = station['id']
                price = await fetch_real_price_mock_api(aio_session, osm_id, station['lat'], station['lon'])
                return osm_id, price

        tasks = [worker(s) for s in valid_stations]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        for res in results:
            if isinstance(res, tuple) and res[1] is not None:
                osm_id, price = res
                price_map[osm_id] = price

    return price_map

def process_and_upsert_stations():
    """Process Overpass stations and perform chunked upsert to Supabase."""
    raw_nodes = fetch_overpass_stations()
    if not raw_nodes:
        print("No stations retrieved.")
        return

    print(f"Retrieved {len(raw_nodes)} raw stations. Fetching prices...")
    
    # Run async price fetching
    price_map = asyncio.run(populate_station_prices(raw_nodes))

    records = []
    for node in raw_nodes:
        osm_id = node['id']
        tags = node.get('tags', {})
        
        brand = tags.get('brand') or tags.get('name') or 'Independent'
        name = tags.get('name') or f"{brand} Gas Station"
        street = tags.get('addr:street', 'Ontario Regional Rd')
        city = tags.get('addr:city', 'Ontario')
        address = f"{street}, {city}"
        
        price = price_map.get(osm_id, round(random.uniform(178.9, 186.9), 1))

        records.append({
            'id': osm_id,
            'name': name,
            'brand': brand,
            'address': address,
            'lat': node.get('lat'),
            'lng': node.get('lon'),
            'price': price,
            'updated': 'Just now'
        })

    # Chunked upsert with batch size 100
    batch_size = 100
    print(f"Upserting {len(records)} records to Supabase in batches of {batch_size}...")

    for i in range(0, len(records), batch_size):
        chunk = records[i:i + batch_size]
        try:
            supabase.table('stations').upsert(chunk).execute()
            print(f"Successfully upserted batch {i // batch_size + 1}")
        except Exception as e:
            print(f"Failed to upsert batch starting at index {i}: {e}")

if __name__ == "__main__":
    process_and_upsert_stations()
