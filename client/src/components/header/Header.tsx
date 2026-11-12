import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import useAccountSlotStore from '../../store/AccountSlot.store';
import { GroupedOption, NumericOption, NumericOrStringOption, Option, Skills, User } from '../../models/interfaces/Props.interfaces';
import { JobData } from '../../models/interfaces/Props.interfaces';
import { JobsFilterStore, jobsFilterStore } from '../../store/JobsFilter.store';
import BasicModal from '../common/BasicModal';
import DropDown from '../common/DropDown';
import CheckBoxAutocomplete from '../common/CheckBoxAutocomplete';
import SearchBar from '../common/SearchBar';
import { LocationService } from '../../services/api/Location.service';
import { arraysAreEqual, isString } from '../../utils/utils';
import { i18n } from '../../i18n/I18n';
import { CustomCitySymbol, DistrictsOptions, LocalizedDataKey, LocationGroupIds, isStaffRole, staffHomeRoute } from '../../i18n/General.enums';
import { languageStore } from '../../store/Language.store';
import { FilterParamsKeys, OptionType } from '../../models/interfaces/General.interfaces';
import { JobService } from '../../services/api/Job.service';
import { getLocalizedOptions } from '../../i18n/i18nHelper';
import useToastStore from '../../store/Toast.store';
import { useLocation, useNavigate } from 'react-router-dom';
import LoginModal from '../login/LoginModal';
import { useSignInReturn, ssoSignOut } from '../../utils/signIn';
import useModalStore from '../../store/Modal.store';
import ResetPasswordRequest from '../ResetPasswordRequest';
import ResetPassword from '../ResetPassword';
import RegisterUser from '../register/RegisterUser';
import { useProfileModals } from '../register/profileModals';
import useAuthStore from '../../store/Auth.store';
import { ClientRoutes } from '../../i18n/ClientRoutes.enum';
import Toast from '../common/Toast';
import { LoginService } from '../../services/api/Login.service';
import Button from '../common/Button';
import useHeaderStore from '../../store/HeaderStore';
import { ExtendedJobCard, FormHandle } from '../jobcard/ExtendedJobCard';
import { ApplyJobButtons } from '../jobcard/ApplyJobButtons';
import { effectiveApplyPolicy } from '../../utils/applyPolicy';
import MenuIcon, { CheckContainedIcon, LogoutIcon, SettingsIcon, UserIcon } from '../../icons';
import { SkillsService } from '../../services/api/Skills.service';
import { AdminPanelHeader } from './AdminPanelHeader';
import { BasicHeader } from './BasicHeader';
import Sidebar from '../common/SideBar';
import { DirectApplyJobCard } from '../jobcard/directApplyJobCard';
import { useSearchParams } from "react-router-dom";
import { track } from '../../utils/analytics';

interface RenderSubHeaderProps {
  activeJob?: JobData;
  activeJobIndex?: number;
}

const Header: React.FC<RenderSubHeaderProps> = ({ activeJob, activeJobIndex }) => {
  const location = useLocation();
  const { initModal, closeModal, active, openPendingModalIfExists } = useModalStore();
  const translations = i18n.getTranslations();
  const { openLogin, setOpenLogin,setUserTryToApply,userTryToApply } = useAuthStore();
  const navigate = useNavigate();
  const { isVisible, message, severity, closeToast, showToast } = useToastStore();
  const { user, logOut } = useAuthStore();
  const [loginModalStatus, setLoginModalStatus] = useState<Boolean>(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const profileModals = useProfileModals();
  // Back from "Continue with Google" (xhostd SSO): a new identity fills the sign-up form; missing details → complete them.
  useSignInReturn({ onSignup: profileModals.openSsoSignup, onIncomplete: profileModals.openComplete });
  const formRef = useRef<FormHandle>(null);
  

const [searchParams, setSearchParams] = useSearchParams();

const initializedFromUrlRef = useRef(false);
const lastAppliedSearchRef = useRef<string>("");

const PARAMS: FilterParamsKeys = {
  searchValue: 'searchValue',
  scope: 'scope',
  city: 'city',
  district: 'district',
  skills: 'skills',
};

const encodeList = (arr: (string|number)[]) =>
  arr.filter(x => x !== null && x !== undefined && `${x}`.trim() !== '').join(',');

const getList = (sp: URLSearchParams, key: string) =>
  (sp.get(key)?.split(',').map(s => s.trim()).filter(Boolean)) ?? [];


    const GuestApply = async () => {
    if (formRef.current) {
      await formRef.current.submit();
    }
  };
//modal overflow hidden
  useEffect(() => {
    if (active) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [active]);

  useEffect(() => {
    if (activeJob) {
      const version = (typeof activeJobIndex == 'number' && activeJobIndex % 2 == 0) ? 1 : 2;
      initModal({
        active: true,
        modalTitle: activeJob.title,
        modalBody:
          <div>
            <div className='p-4 height-26rem overflow-auto custom-scrollbar'>
              <ExtendedJobCard jobData={activeJob} source="direct" />
            </div>
            <div className={`text-start bg-light w-100 custom-border-top border-dark border-xs-0 py-2 px-3 height-5-625rem d-flex justify-content-center justify-content-sm-end align-items-center xs-top-shadow`} >
              <ApplyJobButtons openDirectApplyModal={openDirectApplyModal} isSelfApply={activeJob.isSelfApply} quickApply={effectiveApplyPolicy(activeJob).quickApply} jobId={activeJob._id!} handleGuestApply={GuestApply}/>
            </div>
          </div>,
        modalStyle: {
          modalClass: 'modal-slide-up',
          dialogClassName: ' modal-fullscreen-sm-down max-width-72-125rem xs-p-0',
          headerClass: version === 2 ? 'bg-color-light-green' : 'bg-color-dark-green',
          titleClass: `font-EzerRegularLoft ${version === 2 ? '' : 'text-white'}`,
          bodyClass: 'p-0',
          closeButtonColor: `${version === 2 ? '' : 'white'}`
        }
      })
    }
  }, []);

  useEffect(() => {
    if (openLogin) {
      activateLoginModal();
      setOpenLogin(false)
    }
  }, [openLogin]);

  useEffect(() => {
    if (active === true) {
      activateLoginModal();
      setOpenLogin(false)
    }
  }, [initModal]);

  useEffect(() => {
    if (location.pathname === ClientRoutes.InitializePassword) {
      activateRequestResetPasswordModal({ isFirstPasswordInitialization: true });
    }
  }, [location]);

  useEffect(() => {
    const searchParams = new URLSearchParams(location.search);
    const tokenParam = searchParams.get('token');

    if (tokenParam) {
      initModal({
        active: true,
        modalTitle: translations.ResetPassword.Title,
        modalBody: (
          <ResetPassword token={tokenParam} />
        ),
        modalStyle: {
          dialogClassName: "max-width-37-5rem",
          bodyClass: "p-0",
          titleClass: 'font-RubikBold fs-1-125rem'
        }
      })
    }
  }, [location.search]);

  
  // Function to open Login modal
  const activateLoginModal = () => {
    setLoginModalStatus(true)
    initModal({
      active: true,
      modalTitle: !userTryToApply ?translations.Header.Login : translations.Header.AlreadyRegisteredMessage ,
      modalBody: (<div style={{ minHeight: '28.437rem' }}>
        <LoginModal
          onForgotPasswordClick={activateRequestResetPasswordModal}
          onSuccess={() => {
            setLoginModalStatus(false)
            closeModal();
            openPendingModalIfExists();
          }}
          onRegisterButtonClicked={activateRegisterModal}
        />
      </div>),
      modalStyle: {
        dialogClassName: "max-width-37-5rem",
        bodyClass: "p-0",
        titleClass: 'font-RubikBold fs-1-125rem'
      },
      onClose: () => { setLoginModalStatus(false); openPendingModalIfExists(); setUserTryToApply(false) },
    });
  };

  const activateRegistrationSuccessModal = () => {
    initModal({
      active: true,
      modalBody: (
        <div className='d-flex justify-content-center flex-column align-items-center text-center mt-2'>
          <div className="mt-2 mb-4 d-flex justify-content-center align-items-center rounded-circle size-3-375rem background-color-green-mint border-color-green-sage border-width-0-5-rem border">
            <CheckContainedIcon size={25}/>
          </div>
          <h1 className='font-RubikBold m-0 fs-5 mb-4'>{translations.Register.RegistrationSuccess}</h1>
          <Button
            className='font-RubikMedium my-2 bg-color-dark-green-2 w-100 mb-4 min-w-16rem'
            onClick={() => closeModal()}
          >
            {translations.JobApplicationModal.CloseButton}
          </Button>
        </div>
      ),
      modalStyle: {
        bodyClass: "height-16-375rem d-flex flex-column justify-content-center align-items-center",
        dialogClassName: "max-width-25rem"
      },

    });
  }

  const openDirectApplyModal = () => {
    if(activeJob){
      const urlParams = location.search || '';
      const newUrl = `/job/${activeJob._id!.toString()}${urlParams}`;
      window.history.replaceState({}, '', newUrl);
      initModal({
        onClose: () => {
              window.history.replaceState({}, '', `/${urlParams}`);
        },
        active: true,
        modalTitle: translations.JobCard.ApplyForJob,
        modalBody:
          <div>
            <div className='p-4 height-28rem xs-h-30rem overflow-auto custom-scrollbar'>
              <DirectApplyJobCard jobData={activeJob} />
            </div>
            <div>
              <Button
                className='font-RubikMedium my-2 bg-color-purple-btn w-50 mb-4'
                onClick={() => initModal({ active: false })}
              >
                {translations.JobApplicationModal.CloseButton}
              </Button>
            </div>
          </div>,
        modalStyle: {
          modalClass: 'modal-slide-up',
          dialogClassName: 'width-37-5rem modal-fullscreen-sm-down max-width-72-125rem xs-p-0',
          headerClass: '',
          titleClass: `font-EzerRegularLoft fs-5`,
          bodyClass: 'p-0',
          closeButtonColor: `${''}`
        }
      })
    }
  }

  
  const activateRegisterModal = () => {
    setLoginModalStatus(false)
    initModal({
      active: true,
      modalTitle: `${translations.Header.SignUp}`,
      modalBody: <RegisterUser onSuccess={() => { activateRegistrationSuccessModal(); }} />,
      modalStyle: {
        dialogClassName: "max-width-72-06rem",
        bodyClass: "p-0",
        titleClass: 'font-RubikBold fs-4'
      },
      onClose: () => { openPendingModalIfExists(); },
    });
  };

  const renderHeader = () => {
    switch (location.pathname) {
      case ClientRoutes.JobsManagement:
        return <AdminPanelHeader user={user} logOutCallback={handleLogout} />;

      case ClientRoutes.UsersManagement:
        return <AdminPanelHeader user={user} logOutCallback={handleLogout} />;

      case ClientRoutes.SecurityManagement:
        return <AdminPanelHeader user={user} logOutCallback={handleLogout} />;

      case ClientRoutes.JobSubmissions:
        return <AdminPanelHeader user={user} logOutCallback={handleLogout} />;

      case ClientRoutes.PostJob:
        return <BasicHeader user={user} logOutCallback={handleLogout} />;

      case ClientRoutes.JobApplicationsManagement:
        return <BasicHeader user={user} logOutCallback={handleLogout} />;

      default:
        return <JobSearchHeader user={user} logOutCallback={handleLogout} />;
    }
  };

  // Function to open Reset Password modal
  const activateRequestResetPasswordModal = (options?: { isFirstPasswordInitialization?: boolean }) => {
    setLoginModalStatus(false)
    initModal({
      active: true,
      modalTitle: options?.isFirstPasswordInitialization ? translations.InitializePasswordModal.Title : translations.ResetPasswordRequest.Title,
      modalBody:
        <div className='height-28-437rem'>
          <ResetPasswordRequest onRegisterButtonClicked={activateRegisterModal} isFirstPasswordInitialization={options?.isFirstPasswordInitialization} />
        </div>,
      modalStyle: {
        dialogClassName: "max-width-37-5rem",
        bodyClass: "p-0",
        titleClass: 'font-RubikBold fs-1-125rem'
      }
    });
  };

  // Login button, or the signed-in user's menu. On the job board it sits in the
  // list/map toolbar row (portal into the cell Jobs.tsx registers in AccountSlot.store);
  // on other pages that use JobSearchHeader it stays in the header row.
  const RenderButtons: React.FC<{ user?: User | null; logoutCallback: () => void, excludeAdminButton?: boolean }> = ({ user, logoutCallback, excludeAdminButton = false }) => {
    const navigate = useNavigate();
    const [isClient, setIsClient] = useState(false); // Track client-side rendering

    useEffect(() => {
      setIsClient(true); // Set to true after client has hydrated
    }, []);

    if (!isClient) {
      // Return a placeholder or null during SSR
      return null;
    }

    if (!user) {
      return (
        <button
          type="button"
          className={`board-pill board-pill--outline ${loginModalStatus ? 'z-index-high' : 'z-index-low'}`}
          onClick={activateLoginModal}
        >
          <i className="bi bi-person" aria-hidden="true" />
          {translations.Header.Login}
        </button>
      );
    }

    return (
      <>
        <div className="d-none d-lg-flex gap-2 flex-wrap justify-content-end">
          {!excludeAdminButton && isStaffRole(user.role) && (
            <button type="button" className="board-pill board-pill--outline" onClick={() => navigate(staffHomeRoute(user.role))}>
              {translations.Header.AdminSystem}
            </button>
          )}
          <button type="button" className="board-pill board-pill--outline" onClick={() => navigate(ClientRoutes.JobApplicationsManagement)}>
            <i className="bi bi-person" aria-hidden="true" />
            {translations.Header.userDashboard}
          </button>
          <button type="button" className="board-pill board-pill--outline" onClick={logoutCallback}>
            {translations.Header.Logout}
          </button>
        </div>
        <div className="d-flex d-lg-none">
          <button type="button" className="board-pill board-pill--outline board-pill--icon" onClick={() => setSidebarOpen(true)} aria-label={translations.Header.userDashboard}>
            <MenuIcon size={24} />
          </button>
          <Sidebar
            isOpen={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            side="left"
            buttons={[
              {
                label: translations.Header.userDashboard, icon: <UserIcon />, onClick: () => {
                  navigate(ClientRoutes.JobApplicationsManagement)
                  setSidebarOpen(false)
                }
              },
              ...(isStaffRole(user.role) ? [{
                label: translations.Header.AdminSystem, icon: <SettingsIcon />, onClick: () => {
                  navigate(staffHomeRoute(user.role))
                  setSidebarOpen(false);
                }
              }] : []),
            ]
            }
            footerButton={{
              label: translations.Header.Logout,
              icon: <LogoutIcon />,
              onClick: () => {
                logoutCallback()
                setSidebarOpen(false);
              },
            }}
          />
        </div>
      </>
    );
  };


  const JobSearchHeader: React.FC<{ logOutCallback: () => void, user: User | null }> = ({ logOutCallback, user }) => {
    const [noResultsFlag, setNoResultsFlag] = useState(false)
    // Toolbar cell in Jobs.tsx for the login button / user menu (null when the board isn't shown).
    const accountSlot = useAccountSlotStore((s) => s.el);
    const jobsFilter: JobsFilterStore = jobsFilterStore();
    const { showToast } = useToastStore();
    const [search, setSearch] = useState("");
    const { currentLanguage } = languageStore.getState();
    const translations = i18n.getTranslations();
    const [filterIsEmpty,setFilterIsEmpty] = useState(false)
    const { selectedLocationOptions, selectedSkillsOptions, selectedScopeOptions, selectedDistrictsOptions,
      setSelectedLocationOptions, setSelectedDistrictsOptions, setSelectedSkillsOptions, setSelectedScopeOptions,
      setScopeOptions, setSkillOptions, setLocationOptions, setDistrictsOptions,
      locationOptions, districtOptions, skillsOptions, scopeOptions } = useHeaderStore();
    const requestIdRef = useRef(0);
    const prevSearchedRef = useRef<string>('');  
    const fetchLocationsAndDistricts = async () => {
      const result = await LocationService.getInstance().fetchAllLocationsAndDistricts();
      if (isString(result)) {
        showToast(
          result,
          "error",
        )
        return ;
      }
      return result
    };

    const fetchSkills = async () => {
      const result = await SkillsService.getInstance().fetchSkillsListRequest();
    if (isString(result)) {
      showToast(
          result,
        "error",
      )
      return [];
    }
    return result.skills || [];
  }

const setUrlFromFilters = (p: {
  inputValue?: string;
  jobScopeIds: (string|number)[];
  jobCitySymbol: (string|number)[];
  jobDistricts: (string|number)[];
  jobSkillsIds: (string|number)[];
}) => {
  const next = new URLSearchParams(window.location.search);

  p.inputValue && p.inputValue.trim()
    ? next.set(PARAMS.searchValue, p.inputValue.trim())
    : next.delete(PARAMS.searchValue);

  const encodeList = (arr: (string|number)[]) =>
    arr.filter(x => x !== null && x !== undefined && `${x}`.trim() !== '').join(',');

  encodeList(p.jobScopeIds)   ? next.set(PARAMS.scope,   encodeList(p.jobScopeIds))   : next.delete(PARAMS.scope);
  encodeList(p.jobCitySymbol) ? next.set(PARAMS.city,    encodeList(p.jobCitySymbol)) : next.delete(PARAMS.city);
  encodeList(p.jobDistricts)  ? next.set(PARAMS.district,encodeList(p.jobDistricts))  : next.delete(PARAMS.district);
  encodeList(p.jobSkillsIds)  ? next.set(PARAMS.skills,  encodeList(p.jobSkillsIds))  : next.delete(PARAMS.skills);

  const nextStr = next.toString();
  if (lastAppliedSearchRef.current === nextStr) return; 
  lastAppliedSearchRef.current = nextStr;

  const newUrl =
    `${window.location.pathname}${nextStr ? `?${nextStr}` : ''}${window.location.hash || ''}`;

  window.history.replaceState(window.history.state, '', newUrl);
};

const fetchJobs = React.useCallback(async (
  searchValue: string,
  overrides?: {
    jobScopeIds?: (string|number)[];
    jobCitySymbol?: (string|number)[];
    jobDistricts?: (string|number)[];
    jobSkillsIds?: (string|number)[];
  }
) => {
  if (active) return;

  const inputValue    = searchValue;
  const jobScopeIds   = (overrides?.jobScopeIds ?? selectedScopeOptions.map(x => x.value)) as (string|number)[];
  const jobCitySymbol = (overrides?.jobCitySymbol ?? selectedLocationOptions.map(x => x.value)) as (string|number)[];
  const jobDistricts  = (overrides?.jobDistricts ?? selectedDistrictsOptions.map(x => x.value)) as (string|number)[];
  const jobSkillsIds  = (overrides?.jobSkillsIds ?? selectedSkillsOptions.map(x => x.value)) as (string|number)[];

  setUrlFromFilters({ inputValue, jobScopeIds, jobCitySymbol, jobDistricts, jobSkillsIds });

  const reqId = ++requestIdRef.current;
  const joblist = await JobService.getInstance().getActiveJobs({
    includeRandomSponsoredJobs: true,
    jobScopeIds:   jobScopeIds   as string[],
    jobCitySymbol: jobCitySymbol as number[],
    jobDistricts:  jobDistricts  as string[],
    jobSkillsIds:  jobSkillsIds  as string[],
    jobStatus: ['Active'],
    inputValue,
  });

  if (reqId !== requestIdRef.current) return;

  if (isString(joblist)) {
    showToast(joblist, "error");
    // First load of a filtered URL failed: stop the board's spinner (it shows "no results").
    if (jobsFilterStore.getState().loading) jobsFilter.initJobList([]);
  } else {
    jobsFilter.initJobList(joblist.jobs);
    // Whether text was typed (never the text) and how many filters of each kind.
    const filterCount = jobScopeIds.length + jobCitySymbol.length + jobDistricts.length + jobSkillsIds.length;
    if (inputValue.trim() || filterCount) {
      track('job_search', {
        has_search_text: !!inputValue.trim(), filter_count: filterCount, filter_scope_count: jobScopeIds.length,
        filter_location_count: jobCitySymbol.length + jobDistricts.length, filter_skill_count: jobSkillsIds.length,
        results_count: joblist.jobs.length,
      });
    }
  }
}, [
  active,
  selectedScopeOptions,
  selectedLocationOptions,
  selectedDistrictsOptions,
  selectedSkillsOptions,
  setUrlFromFilters,
  showToast,
  jobsFilter,
]);

    const loadData = async () => {
      return await fetchLocationsAndDistricts();
    };


const toNum = (s: string) => {
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const parseCsvNums = (sp: URLSearchParams, key: string) =>
  getList(sp, key)                     
    .map(toNum)                           
    .filter((n): n is number => n !== null);  

useEffect(() => {
  if (initializedFromUrlRef.current) return;
  initializedFromUrlRef.current = true;

  const sp = searchParams;
  const inputValue      = sp.get(PARAMS.searchValue) ?? "";
  const scopeIdsFromUrl = getList(sp, PARAMS.scope);
  const districtsFromUrl= getList(sp, PARAMS.district);
  const skillsFromUrl   = getList(sp, PARAMS.skills);
  const citiesFromUrl   = parseCsvNums(sp, PARAMS.city);

  if (sp.has(PARAMS.searchValue)) setSearch(inputValue);

  urlValuesRef.current = {
    scopeIdsFromUrl,
    districtsFromUrl,
    skillsFromUrl,
    citiesFromUrl,
    inputValue,
  };
}, [searchParams]);

const urlValuesRef = useRef<{
  scopeIdsFromUrl: string[];
  districtsFromUrl: string[];
  skillsFromUrl: string[];
  citiesFromUrl: number[];
  inputValue: string;
} | null>(null);

useEffect(() => {
  if (!urlValuesRef.current) return;

  const { scopeIdsFromUrl, districtsFromUrl, skillsFromUrl, citiesFromUrl, inputValue } = urlValuesRef.current;

  const selectedCities = locationOptions.filter(opt => citiesFromUrl.includes(opt.value as number));
  setSelectedLocationOptions(selectedCities as NumericOption[]);

  const selectedDistricts = districtOptions.filter(opt => districtsFromUrl.includes(opt.value as string));
  setSelectedDistrictsOptions(selectedDistricts);

  const selectedSkills = skillsOptions.filter(opt => skillsFromUrl.includes(opt.value as string));
  setSelectedSkillsOptions(selectedSkills);

  const selectedScopes = scopeOptions.filter(opt => scopeIdsFromUrl.includes(opt.value as string));
  setSelectedScopeOptions(selectedScopes);

  // Without filters in the URL the board already shows the list that came with the page:
  // fetching it again would only redraw it (and reshuffle the random hot jobs).
  const urlHasFilters = !!inputValue.trim() || scopeIdsFromUrl.length + districtsFromUrl.length + skillsFromUrl.length + citiesFromUrl.length > 0;
  if (urlHasFilters) handleSearch(inputValue, {
    jobScopeIds: scopeIdsFromUrl,
    jobCitySymbol: citiesFromUrl,
    jobDistricts: districtsFromUrl,
    jobSkillsIds: skillsFromUrl,
  });

  urlValuesRef.current = null;
}, []);

    useEffect(() => {
      if (!active) {
        const fetchData = async () => {
          const skills = await fetchSkills();
          const skillOptions = skills.map((x: { _id: string; name: string }) => ({
            value: x._id,
            label: x.name,
          }));
          const scopes = getLocalizedOptions(LocalizedDataKey.JOB_SCOPE, currentLanguage);
          const result = await loadData();
          const locations = result?.locations || [];
          const filteredLocations = (result?.locations || []).filter(
            location => location.citySymbol !== CustomCitySymbol.WorkFromAnyPlace
          );
          const districts = result?.districts || [];
          const updateLocations = filteredLocations.map((location) => ({
            value: location.citySymbol!,
            label: location.city,
          }))
          setLocationOptions(updateLocations);
          setDistrictsOptions(
            districts
              ?.filter(x => x !== DistrictsOptions.NATIONWIDE) // Exclude the specific value
              .map(x => ({ value: x, label: x }))
          );
          
          setSkillOptions(skillOptions);
          setScopeOptions(scopes);
        };

        fetchData();
      }
    }, []);

    useEffect(()=>{
      if(filterIsEmpty){
        handleSearch();
        setFilterIsEmpty(false)
      }
    },[filterIsEmpty])



    const handleLocationSelectionChange = (selected: {
      groupId: string;
      options: NumericOrStringOption[];
    }[]): void => {

      // Separate options by group
      const locationsOptions = selected.find((group) => group.groupId === LocationGroupIds.City)?.options || [];
      const districtOptions = selected.find((group) => group.groupId === LocationGroupIds.District)?.options || [];

      // Update state only if there are changes
      if (
        !arraysAreEqual(locationsOptions, selectedLocationOptions) ||
        !arraysAreEqual(districtOptions, selectedDistrictsOptions)
      ) {
        setSelectedLocationOptions(locationsOptions as NumericOption[]);
        setSelectedDistrictsOptions(districtOptions as Option[]);
        const isAllGroupsEmpty = selected.every(group => group.options.length === 0);
        if (isAllGroupsEmpty) {
          setFilterIsEmpty(true);
        }
      }
    };

    const handleSkillsSelectionChange = (selected: OptionType[]) => {
      if (selectedSkillsOptions !== selected && !active) {
        setSelectedSkillsOptions(selected);
        if(selected.length==0){
          setFilterIsEmpty(true)
        }
      }
    };

    const handleJobScopeSelectionChange = (selected: OptionType[]) => {
      if (selectedScopeOptions !== selected && !active) {
        setSelectedScopeOptions(selected);
        if(selected.length==0){
          setFilterIsEmpty(true)
        }
      }
    };

useEffect(() => {
  const searchValue = search.trim();
  const id = setTimeout(() => {
    if (searchValue !== prevSearchedRef.current) {
      prevSearchedRef.current = searchValue;
      fetchJobs(searchValue);
    }
  }, 300);
  return () => clearTimeout(id);
}, [search]);


const handleSearch = (
  customInputValue?: string,
  overrides?: {
    jobScopeIds?: (string|number)[];
    jobCitySymbol?: (string|number)[];
    jobDistricts?: (string|number)[];
    jobSkillsIds?: (string|number)[];
  }
) => {
  const searchValue = (customInputValue ?? search).trim();
  return fetchJobs(searchValue, overrides);
};

    

    const changeNamesOptions = {
      "משרד ראשי": "משרד ראשי",
      "ב\"ש והדרום": "באר שבע והדרום",
      "ירושלים": "ירושלים",
      "ת\"א והמרכז": "תל אביב והמרכז",
      "חיפה וצפון": "חיפה והצפון",
    };

    useEffect(() => {
      if (jobsFilter.jobList.length) {
        setNoResultsFlag(false);
      } else {
        setNoResultsFlag(true);
      }
    }, [jobsFilter.jobList])



    const clearSearch = () => {
      setSearch('');
    };

    const locationGroupedOptions: GroupedOption[] = [
      {
        groupId: LocationGroupIds.District,
        groupLabel: 'אזור',
        options: districtOptions || [],
      },
      {
        groupId: LocationGroupIds.City,
        groupLabel: 'עיר',
        options: locationOptions || [],
      },
    ];

    const preSelectedOptions = {
      [LocationGroupIds.City]: selectedLocationOptions,
      [LocationGroupIds.District]: selectedDistrictsOptions,
    };


    function clearAllFillters(): void {
      setSelectedLocationOptions([])
      setSelectedDistrictsOptions([])
      setSelectedSkillsOptions([])
      setSelectedScopeOptions([])
      clearSearch()
      setFilterIsEmpty(true)
    }

    // Header, filters and (in Jobs.tsx) the list/map toolbar all sit in `.board-frame`,
    // the same width as the job cards (see App.scss "Job board frame").
    return (
      <header className="board-header">
        <div className="container">
          <div className="board-frame">
            <div className="board-header__top">
              <a href={ClientRoutes.MainPage} className="board-header__logo">
                <img src="/images/logo.svg" alt="Logo" className="logo" />
              </a>

              <h1 className="board-header__title font-EzerRegularLoft">
                {translations.Header.OurJobs}
              </h1>

              <div className="board-header__actions">
                <a href={ClientRoutes.PostJob} className="board-pill board-pill--employer" aria-label={translations.EmployerForm.HeaderButtonLabel}>
                  <i className="bi bi-briefcase" aria-hidden="true" />
                  <span>{translations.EmployerForm.HeaderButton}</span>
                </a>
                {accountSlot
                  ? createPortal(<RenderButtons user={user} logoutCallback={logOutCallback} />, accountSlot)
                  : <RenderButtons user={user} logoutCallback={logOutCallback} />}
              </div>
            </div>

            <div className="board-filters">
              {/* Search Bar */}
              <div className="board-filters__search">
                <SearchBar
                  searchTerm={search}
                  setSearchTerm={setSearch}
                  handleSearch={handleSearch}
                  noResults={noResultsFlag}
                  placeHolderText={translations.Header.SearchPlaceholder}
                  clearSearch={clearSearch}
                />
              </div>

              {/* Filters */}
              <div className="board-filters__filter">
                <CheckBoxAutocomplete
                  groupedOptions={locationGroupedOptions}
                  onSelect={handleLocationSelectionChange}
                  selectedOptions={preSelectedOptions}
                  onSearch={handleSearch}
                  changeNamesOptions={changeNamesOptions}
                  className=""
                />
              </div>
              <div className="board-filters__filter">
                <DropDown
                  title={translations.RenderSubHeader.SKILLS}
                  options={skillsOptions}
                  selectedOptions={selectedSkillsOptions}
                  onSelect={handleSkillsSelectionChange}
                  onSearch={handleSearch}
                  className=""
                />
              </div>
              <div className="board-filters__filter">
                <DropDown
                  title={translations.RenderSubHeader.JOB_SCOPE}
                  options={scopeOptions}
                  selectedOptions={selectedScopeOptions}
                  onSelect={handleJobScopeSelectionChange}
                  onSearch={handleSearch}
                  className=""
                />
              </div>
              <button
                type="button"
                className="board-filters__clear font-RubikMedium text-color-dark-green-2"
                onClick={clearAllFillters}
              >
                {translations.General.ClearAll}
              </button>

              {/* No Results Message */}
              {noResultsFlag && search && (
                <p role="status" className="board-filters__message text-color-red font-RubikMedium">
                  {translations.RenderSubHeader.NO_RESULTS}
                </p>
              )}
            </div>
          </div>
        </div>
      </header>
    );
  };

  const handleLogout = async () => {
    logOut(); //client logout
    const result = await LoginService.getInstance().logoutRequest(); //request server to remove http-only cookies
    if (isString(result)) {
      showToast(result, "error");
    } else {
      if (await ssoSignOut()) return; // also end the xhostd SSO session
      navigate(ClientRoutes.MainPage)
      showToast(translations.Header.LogoutSuccessMessage, "success");
    }
  };

  return (
    <>
      <Toast
        open={isVisible}
        severity={severity}
        onClose={closeToast}
        message={message}
      />
      {activeJob ? // for SSR purposes
        <BasicModal
          initialTitle={activeJob?.title}
          initialBody={<ExtendedJobCard jobData={activeJob} />}
          initialFooter={<ApplyJobButtons openDirectApplyModal={openDirectApplyModal} isSelfApply={activeJob.isSelfApply} quickApply={effectiveApplyPolicy(activeJob).quickApply} jobId={activeJob._id!} handleGuestApply={GuestApply}/>}
        /> :
        <BasicModal />}
       {renderHeader()}
    </>
  );
}

export default Header;