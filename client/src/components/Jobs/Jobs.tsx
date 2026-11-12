import { lazy, Suspense, useEffect, useState } from 'react';
import { JobService } from '../../services/api/Job.service';
import { jobsFilterStore, JobsFilterStore, urlHasJobFilters } from '../../store/JobsFilter.store';
import JobCard from '../jobcard/JobCard';
import { JobData } from '../../models/interfaces/Props.interfaces';
import { useParams } from 'react-router-dom';
import NoResults from '../jobcard/NoResults';
import ToastStore from '../../store/Toast.store';
import { isString } from '../../utils/utils';
import Spinner from '../common/Spinner';
import { i18n } from '../../i18n/I18n';
import useAccountSlotStore from '../../store/AccountSlot.store';
import { track, trackOnce } from '../../utils/analytics';

// Leaflet is loaded only when someone opens the map view. If its files are gone
// (page opened before a deploy), entry-client reloads the page (the URL keeps
// ?view=map); until then, or if that fails too, show a message, not a blank page.
const MapJobSearch = lazy(() => import('./MapJobSearch')
  .catch((e) => {
    console.error('[map] could not load the map view', e);
    const Failed = () => <p className="pt-4 text-center" role="alert">{i18n.getTranslations().ToastMessages.ERROR}</p>;
    return { default: Failed };
  }));
const VIEW_PARAM = 'view';
const MAP_VIEW = 'map';
const readViewFromUrl = () =>
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get(VIEW_PARAM) === MAP_VIEW;

interface JobsProps {
    jobList?: JobData[]; // Job list data from SSR or client
    isServer?: boolean;
}

const Jobs: React.FC<JobsProps> = ({ jobList: initialJobList ,isServer:isServer }) => {
    const { showToast } = ToastStore();
    const jobsFilter: JobsFilterStore = jobsFilterStore();
    const { jobId } = useParams<{ jobId: string }>(); // Type for URL parameter
    
    // The list lives in the filter store, which starts with the list that came with the
    // page (JobsFilter.store.ts). `loading` is true only until the first list for this URL
    // is in, so the board never shows "no jobs" before the jobs had a chance to arrive.
    const jobList = jobsFilter.jobList;
    const isLoading = jobsFilter.loading;
    const [mapView, setMapView] = useState<boolean>(readViewFromUrl);
    const t = i18n.getTranslations().MapSearch;
    const setAccountSlot = useAccountSlotStore((s) => s.setEl);

    const switchView = (toMap: boolean) => {
      if (toMap !== mapView) track('view_switch', { view: toMap ? 'map' : 'list' });
      setMapView(toMap);
      const next = new URLSearchParams(window.location.search);
      toMap ? next.set(VIEW_PARAM, MAP_VIEW) : next.delete(VIEW_PARAM);
      const qs = next.toString();
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash || ''}`);
    };

    // Toolbar row: list/map switch, and a cell where Header.tsx portals the login
    // button / user menu. Same width as the cards (`.board-frame`, App.scss). Keep it
    // at one place in the tree for both views so the slot element stays the same.
    const toolbar = (
      <div className="board-frame board-toolbar">
        <div className="view-switch" role="group" aria-label={t.ViewSwitchLabel}>
          <button type="button" className="view-switch__btn" aria-pressed={!mapView} onClick={() => switchView(false)}>
            <i className="bi bi-list-ul" aria-hidden="true" />{t.ListView}
          </button>
          <button type="button" className="view-switch__btn" aria-pressed={mapView} onClick={() => switchView(true)}>
            <i className="bi bi-geo-alt" aria-hidden="true" />{t.MapView}
          </button>
        </div>
        <div className="board-toolbar__account" ref={setAccountSlot} />
      </div>
    );

    // No list came with the page (should not happen): fetch it. A URL with filters is
    // fetched by the search bar (Header.tsx), which fills the same store.
    useEffect(() => {
      if (!isLoading || urlHasJobFilters()) return;
      let cancelled = false;
      (async () => {
        const result = await JobService.getInstance().getActiveJobs({ includeRandomSponsoredJobs: true });
        if (cancelled) return;
        if (isString(result)) {
          showToast(result, "error");
          jobsFilter.initJobList([]);
          return;
        }
        jobsFilter.initJobList(result.jobs);
      })();
      return () => { cancelled = true; };
    }, []);

    useEffect(() => {
      if (!isLoading && !mapView) trackOnce('job_list_view', 'job_list_view', { view: 'list', results_count: jobList?.length ?? 0 });
    }, [isLoading, mapView]);

    //SSR
    if(isServer){
      if (initialJobList?.length) { 
        return <div>
        {initialJobList?.length ? (
          initialJobList.map((item: JobData, index: number) => (
            <JobCard
              index = {index}
              openJob={jobId === item._id?.toString()}
              key={`JobCard${index}`}
              jobData={item}
              version={index % 2 === 0 ? 1 : 2}
            />
          ))
        ) : null }
      </div>
      }
    }
  
    return (
        <div>
        {toolbar}
        {mapView ? (
          <Suspense fallback={<div className="pt-5 d-flex justify-content-center"><Spinner size="lg" color="dark" srText={t.Loading} /></div>}>
            <MapJobSearch />
          </Suspense>
        ) : isLoading ? (
          <div className="pt-5 d-flex justify-content-center">
            <Spinner size="lg" color="dark" srText="" />
          </div>
        ) : jobList?.length ? (
          jobList.map((item: JobData, index: number) => (
            <JobCard
              index = {index}
              openJob={jobId === item._id?.toString()}
              key={`JobCard${index}`}
              jobData={item}
              version={index % 2 === 0 ? 1 : 2}
            />
          ))
        ) : (
          <NoResults /> // Show NoResults component if jobList is empty
        )}
      </div>
    );
  };
export default Jobs;
