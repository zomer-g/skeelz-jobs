import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { track } from '../../utils/analytics';
import { Circle, CircleMarker, MapContainer, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import type { LatLngBoundsExpression, LatLngExpression } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './MapJobSearch.scss';
import { i18n } from '../../i18n/I18n';
import { JobService } from '../../services/api/Job.service';
import { LocationService } from '../../services/api/Location.service';
import { Location } from '../../models/interfaces/Props.interfaces';
import { NearbyJobsResponse } from '../../models/interfaces/Api.interfaces';
import useHeaderStore from '../../store/HeaderStore';
import ToastStore from '../../store/Toast.store';
import { isString } from '../../utils/utils';
import JobCard from '../jobcard/JobCard';
import Spinner from '../common/Spinner';

const RADIUS_OPTIONS = [5, 10, 25, 50, 100];
const DEFAULT_RADIUS = 25;
const ISRAEL_CENTER: LatLngExpression = [31.45, 34.95];
const ISRAEL_BOUNDS: LatLngBoundsExpression = [[29.3, 33.8], [33.5, 36.1]];
const MAX_BOUNDS: LatLngBoundsExpression = [[28.5, 32.5], [34.3, 37.5]];

type PickSource = 'city' | 'geo' | 'map';
interface Picked { lat: number; lng: number; source: PickSource; label?: string }

const insideIsrael = (lat: number, lng: number) => lat > 29 && lat < 34 && lng > 34 && lng < 36.5;
const fmt = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));

/** Map click / Enter-on-map-center picks the point. */
const MapPicker: React.FC<{ onPick: (lat: number, lng: number) => void; label: string }> = ({ onPick, label }) => {
  const map = useMap();
  useMapEvents({ click: (e) => onPick(e.latlng.lat, e.latlng.lng) });
  useEffect(() => {
    const el = map.getContainer();
    el.setAttribute('aria-label', label);
    el.setAttribute('role', 'application');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && e.target === el) {
        const c = map.getCenter();
        onPick(c.lat, c.lng);
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [map, onPick, label]);
  return null;
};

/** Zooms to the search circle whenever the point or radius changes. */
const FitToCircle: React.FC<{ picked: Picked | null; radiusKm: number }> = ({ picked, radiusKm }) => {
  const map = useMap();
  useEffect(() => {
    if (!picked) return;
    const dLat = radiusKm / 111;
    const dLng = radiusKm / (111 * Math.cos((picked.lat * Math.PI) / 180));
    map.fitBounds([[picked.lat - dLat, picked.lng - dLng], [picked.lat + dLat, picked.lng + dLng]], { padding: [16, 16] });
  }, [map, picked, radiusKm]);
  return null;
};

/** Accessible town picker (ARIA combobox): the keyboard alternative to clicking the map. */
const CitySearch: React.FC<{ locations: Location[]; onSelect: (l: Location) => void; clearSignal: unknown }> = ({ locations, onSelect, clearSignal }) => {
  const t = i18n.getTranslations().MapSearch;
  const id = useId();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // A point picked another way (map / my location) clears the town name.
  useEffect(() => { if (clearSignal) setText(''); }, [clearSignal]);
  const matches = useMemo(() => {
    const q = text.trim();
    if (!q) return [];
    const starts = locations.filter((l) => l.city.startsWith(q));
    const contains = locations.filter((l) => !l.city.startsWith(q) && l.city.includes(q));
    return [...starts, ...contains].slice(0, 8);
  }, [text, locations]);

  const choose = (l: Location) => {
    setText(l.city);
    setOpen(false);
    onSelect(l);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, matches.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter' && open && matches[active]) { e.preventDefault(); choose(matches[active]); }
    else if (e.key === 'Escape') { setOpen(false); }
  };

  const showList = open && matches.length > 0;
  return (
    <div className="position-relative">
      <label htmlFor={`${id}-input`} className="form-label mb-1 font-RubikMedium">{t.CitySearchLabel}</label>
      <input
        id={`${id}-input`}
        type="text"
        className="form-control"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={`${id}-list`}
        aria-activedescendant={showList ? `${id}-opt-${active}` : undefined}
        autoComplete="off"
        placeholder={t.CitySearchPlaceholder}
        value={text}
        onChange={(e) => { setText(e.target.value); setOpen(true); setActive(0); }}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      <ul
        id={`${id}-list`}
        role="listbox"
        className={`list-group position-absolute w-100 shadow ${showList ? '' : 'd-none'}`}
        style={{ zIndex: 1100, maxHeight: '16rem', overflowY: 'auto' }}
      >
        {matches.map((l, i) => (
          <li
            key={l.citySymbol}
            id={`${id}-opt-${i}`}
            role="option"
            aria-selected={i === active}
            className={`list-group-item list-group-item-action ${i === active ? 'active' : ''}`}
            style={{ cursor: 'pointer' }}
            onMouseDown={(e) => { e.preventDefault(); choose(l); }}
          >
            {l.city}
          </li>
        ))}
      </ul>
    </div>
  );
};

const MapJobSearch: React.FC = () => {
  const t = i18n.getTranslations().MapSearch;
  const { showToast } = ToastStore();
  const { selectedScopeOptions, selectedSkillsOptions } = useHeaderStore();
  const [locations, setLocations] = useState<Location[]>([]);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [radiusKm, setRadiusKm] = useState(DEFAULT_RADIUS);
  const [result, setResult] = useState<NearbyJobsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [geoMessage, setGeoMessage] = useState('');
  const requestId = useRef(0);
  const radiusId = useId();

  useEffect(() => {
    LocationService.getInstance().fetchAllLocations().then((res) => {
      if (isString(res)) { showToast(res, 'error'); return; }
      setLocations(res.filter((l) => l.citySymbol > 0 && l.lat != null && l.lng != null)
        .sort((a, b) => a.city.localeCompare(b.city, 'he')));
    });
  }, []);

  const scopeIds = selectedScopeOptions.map((o) => o.value).join(',');
  const skillIds = selectedSkillsOptions.map((o) => o.value).join(',');

  useEffect(() => {
    if (!picked) return;
    const reqId = ++requestId.current;
    setLoading(true);
    JobService.getInstance().getJobsNear(picked.lat, picked.lng, radiusKm, {
      jobScopeIds: scopeIds ? scopeIds.split(',') : [],
      jobSkillsIds: skillIds ? skillIds.split(',') : [],
    }).then((res) => {
      if (reqId !== requestId.current) return;
      setLoading(false);
      if (isString(res)) { showToast(res, 'error'); return; }
      setResult(res);
      // Radius and how the point was chosen — never the coordinates or the town.
      track('map_search', {
        radius_km: Math.round(radiusKm), map_point_source: picked.source, results_count: res.total,
        filter_count: (scopeIds ? scopeIds.split(',').length : 0) + (skillIds ? skillIds.split(',').length : 0),
      });
    });
  }, [picked, radiusKm, scopeIds, skillIds]);

  const pickOnMap = useMemo(() => (lat: number, lng: number) => {
    setGeoMessage('');
    setPicked({ lat, lng, source: 'map' });
  }, []);

  const useMyLocation = () => {
    if (!('geolocation' in navigator)) { setGeoMessage(t.GeolocationUnsupported); return; }
    setLocating(true);
    setGeoMessage('');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const { latitude: lat, longitude: lng } = pos.coords;
        if (!insideIsrael(lat, lng)) { setGeoMessage(t.GeolocationOutside); return; }
        setPicked({ lat, lng, source: 'geo' });
      },
      () => { setLocating(false); setGeoMessage(t.GeolocationDenied); },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 }
    );
  };

  const place = picked?.source === 'city' ? picked.label! : picked?.source === 'geo' ? t.YourLocation : t.PickedPoint;

  // One marker per town with jobs in range.
  const townMarkers = useMemo(() => {
    const byTown = new Map<string, { lat: number; lng: number; city: string; count: number }>();
    for (const j of result?.jobs ?? []) {
      const l = j.location as Location | undefined;
      if (l?.lat == null || l?.lng == null) continue;
      const key = `${l.lat},${l.lng}`;
      const cur = byTown.get(key);
      if (cur) cur.count++;
      else byTown.set(key, { lat: l.lat, lng: l.lng, city: l.city, count: 1 });
    }
    return [...byTown.values()];
  }, [result]);

  return (
    <section className="pt-3 mx-auto map-job-search" aria-labelledby={`${radiusId}-heading`}>
      <h2 id={`${radiusId}-heading`} className="visually-hidden">{t.MapView}</h2>

      <div className="row g-3 mb-3">
        {/* Controls: beside the map on wide screens, above it on narrow ones. */}
        <div className="col-12 col-lg-5 d-flex flex-column gap-3">
          <p className="mb-0">{t.Instructions}</p>
          <CitySearch
            locations={locations}
            clearSignal={picked && picked.source !== 'city' ? picked : null}
            onSelect={(l) => { setGeoMessage(''); setPicked({ lat: l.lat!, lng: l.lng!, source: 'city', label: l.city }); }}
          />
          <div>
            <label htmlFor={radiusId} className="form-label mb-1 font-RubikMedium">{t.RadiusLabel}</label>
            <select
              id={radiusId}
              className="form-select"
              value={radiusKm}
              onChange={(e) => setRadiusKm(Number(e.target.value))}
            >
              {RADIUS_OPTIONS.map((r) => <option key={r} value={r}>{r} {t.Km}</option>)}
            </select>
          </div>
          <button type="button" className="btn btn-outline-dark d-inline-flex align-items-center justify-content-center gap-1 w-100" onClick={useMyLocation} disabled={locating}>
            <i className="bi bi-crosshair" aria-hidden="true" />
            {locating ? t.LocatingInProgress : t.UseMyLocation}
          </button>
          {geoMessage && <div className="text-color-red" role="alert">{geoMessage}</div>}

          <div aria-live="polite">
            {!picked ? (
              <p className="mb-0">{t.NoPointYet}</p>
            ) : loading && !result ? (
              <p className="mb-0">{t.Loading}</p>
            ) : result ? (
              <>
                <p className="font-RubikMedium mb-1">
                  {result.total
                    ? fmt(t.ResultsSummary, { count: result.total, radius: radiusKm, place })
                    : fmt(t.ResultsNone, { radius: radiusKm, place })}
                </p>
                {result.withoutCoordinates > 0 && <p className="mb-1 small">{fmt(t.WithoutCoordinates, { count: result.withoutCoordinates })}</p>}
                {result.remote > 0 && <p className="mb-0 small">{fmt(t.RemoteJobs, { count: result.remote })}</p>}
              </>
            ) : null}
          </div>
        </div>

        {/* Square map. Leaflet lays out tiles in LTR; the page around it stays RTL. */}
        <div className="col-12 col-lg-7">
          <div dir="ltr" className="map-job-search__map ratio ratio-1x1 border rounded overflow-hidden">
            <MapContainer
              center={ISRAEL_CENTER}
              zoom={7}
              minZoom={6}
              maxBounds={MAX_BOUNDS}
              bounds={ISRAEL_BOUNDS}
              style={{ height: '100%', width: '100%' }}
              keyboard
            >
              <TileLayer
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                maxZoom={18}
              />
              <MapPicker onPick={pickOnMap} label={t.MapLabel} />
              <FitToCircle picked={picked} radiusKm={radiusKm} />
              {picked && (
                <>
                  <Circle center={[picked.lat, picked.lng]} radius={radiusKm * 1000}
                    pathOptions={{ color: '#1d4d3a', weight: 2, fillOpacity: 0.08 }} interactive={false} />
                  <CircleMarker center={[picked.lat, picked.lng]} radius={7}
                    pathOptions={{ color: '#ffffff', weight: 2, fillColor: '#c0392b', fillOpacity: 1 }} interactive={false} />
                </>
              )}
              {townMarkers.map((m) => (
                <CircleMarker key={`${m.lat},${m.lng}`} center={[m.lat, m.lng]} radius={Math.min(14, 6 + m.count)}
                  pathOptions={{ color: '#1d4d3a', weight: 1, fillColor: '#2e8b57', fillOpacity: 0.85 }}>
                  <Tooltip direction="top">{fmt(t.JobsInCity, { city: m.city, count: m.count })}</Tooltip>
                </CircleMarker>
              ))}
            </MapContainer>
          </div>
        </div>
      </div>

      {loading && (
        <div className="d-flex justify-content-center py-2"><Spinner size="lg" color="dark" srText={t.Loading} /></div>
      )}
      {result?.jobs.map((job, index) => (
        <div key={job._id}>
          <div className="small text-muted mt-2">
            <i className="bi bi-geo-alt mx-1" aria-hidden="true" />
            {fmt(t.DistanceAway, { distance: job.distanceKm })}
          </div>
          <JobCard index={index} openJob={false} jobData={job} version={index % 2 === 0 ? 1 : 2} />
        </div>
      ))}
    </section>
  );
};

export default MapJobSearch;
