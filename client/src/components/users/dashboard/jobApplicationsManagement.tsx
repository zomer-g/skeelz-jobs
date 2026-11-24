import React, { useEffect, useState } from 'react';
import { JobData } from '../../../models/interfaces/Props.interfaces';
import { formatDateToDisplay, getDefaultFilenameByMime, isString } from '../../../utils/utils';
import { JobService } from '../../../services/api/Job.service';
import useToastStore from '../../../store/Toast.store';
import { i18n } from '../../../i18n/I18n';
import { JobStatus, OptionType } from '../../../models/interfaces/General.interfaces';
import SearchBar from '../../common/SearchBar';
import { Col, Row } from 'react-bootstrap';
import DropDown from '../../common/DropDown';
import CircularLoader from '../../common/CircularLoader';
import GenericTable, { Column } from '../../common/GenericTable/GenericTable';
import useAuthStore from '../../../store/Auth.store';
import { ExtendedJobCard } from '../../jobcard/ExtendedJobCard';
import useModalStore from '../../../store/Modal.store';
import Button from '../../common/Button';
import { UploadFileService } from '../../../services/api/UploadFile.service';
import { UserService } from '../../../services/api/User.service';
import { UploadFileModal } from '../../common/UploadFileModal';
import { WarningIcon } from '../../../icons';
import { useProfileModals } from '../../register/profileModals';
import { UserRole, isCandidateUser, isEmployerUser } from '../../../i18n/General.enums';
import { ClientRoutes } from '../../../i18n/ClientRoutes.enum';
import LegacyReadOnlyDetails from './LegacyReadOnlyDetails';

const JobsApplicationsManagement: React.FC = () => {
  const translations = i18n.getTranslations();
  const statusOptions: OptionType[] = [
    { value: JobStatus.ACTIVE, label: translations.Jobs.Active },
    { value: JobStatus.CLOSED, label: translations.Jobs.Closed },
  ];

  const formatDateTranslations = {
    today: translations.Jobs.Today,
    yesterday: translations.JobCard.Yesterday,
    days: translations.JobCard.Days,
  };
  const [search, setSearch] = useState('');
  const [paginationModel, setPaginationModel] = useState({ page: 0, pageSize: 8 });
  const [totalJobs, setTotalJobs] = useState<number>(0);
  const [selectedStatus, setSelectedStatus] = useState<OptionType[]>([]);
  const [selectedRow, setSelectedRow] = useState<JobData | null>(null);
  const [sortConfig, setSortConfig] = useState<{ field: string | null; sort: 'asc' | 'desc' | null }>({
    field: null,
    sort: null,
  });
  const [jobs, setJobs] = useState<JobData[]>([]);
  const { showToast } = useToastStore();
  const [loading, setLoading] = useState(false);
  const { user } = useAuthStore();
  // A candidate of the existing site before the cutover: view only (no edit, no CV upload or removal).
  const [readOnly, setReadOnly] = useState(false);
  const setUser = useAuthStore.getState().setUser;
  const { initModal } = useModalStore();
  const { openEdit } = useProfileModals();


  const handleRowClick = (row: JobData) => {
    setSelectedRow(row);
  };

  useEffect(()=>{
    if(selectedRow){
      openJobDetailsModal(selectedRow)
    }

  },[selectedRow])

  const openJobDetailsModal = (row: any) => {
    initModal({
      onClose() {
        setSelectedRow(null)
      },
      active: true,
      modalTitle: selectedRow?.title,
      modalBody:
        <div>
          <div className='p-4 height-33rem overflow-auto custom-scrollbar'>
            <ExtendedJobCard jobData={row} />
          </div>
          <div className={`text-start bg-light w-100 custom-border-top border-dark border-xs-0 py-2 px-3 height-5-625rem d-flex justify-content-center justify-content-sm-end align-items-center xs-top-shadow`} >       
          </div>
        </div>,
      modalStyle: {
        modalClass: 'modal-slide-up',
        dialogClassName: ' modal-fullscreen-sm-down max-width-72-125rem xs-p-0',
        headerClass: 'bg-color-dark-green',
        titleClass: 'font-EzerRegularLoft text-white',
        bodyClass: 'p-0',
        closeButtonColor: `${'white'}`
      }
    })
  }

      function deleteCvModal() {
        initModal({
            active: true,
            modalBody: (
                <div className='d-flex justify-content-center flex-column align-items-center text-center'>
                    <div className="my-2 d-flex justify-content-center align-items-center rounded-circle size-3-375rem background-color-green-mint border-color-green-sage border-width-0-5-rem border">
                        <WarningIcon />
                    </div>
                    <h1 className='font-RubikBold py-3 m-0 fs-5'>{translations.Cv.DeleteCvTitle}</h1>
                    <p className='font-RubikRegular text-color-dark-grey text- mb-4'>{translations.Cv.DeleteCvWarning}</p>
                    <div className='d-flex gap-2'>
                        <Button
                            className='font-RubikMedium my-2 bg-color-dark-green-2 width-9rem h-3rem mb-4'
                            onClick={() => { handleDeleteFile()}
                            }
                        >
                            {translations.General.Confirm}
                        </Button>
                        <Button
                            className='font-RubikMedium my-2 text-color-dark-green border-color-dark-green-2-2px width-9rem h-3rem mb-4'
                            onClick={() => initModal({ active: false })}
                        >
                            {translations.General.Cancel}
                        </Button>
                    </div>
                </div>
            ),
            modalStyle: {
                bodyClass: "height-16-375rem d-flex flex-column justify-content-center align-items-center",
                dialogClassName: "max-width-25rem"
            }
        });
        }
        
  async function handlePreviewFile() {
    try {
      if (user?._id) {
        // The caller's own profile CV (no user id: /users/me/cv/file).
        const result = await UploadFileService.getInstance().fetchMyCvFile();

        if (!isString(result)) {
          const contentType = result.headers['content-type'] || 'application/octet-stream';
          const blob = new Blob([result.data], { type: contentType });

          const disposition = result.headers['content-disposition'];
          const match = disposition?.match(/filename="?([^"]+)"?/);
          const filename = match?.[1] || getDefaultFilenameByMime(contentType);

          const url = window.URL.createObjectURL(blob);

          const isPdf = contentType === 'application/pdf';
          if (isPdf) {//new tab  
            window.open(url, '_blank');
            setTimeout(() => window.URL.revokeObjectURL(url), 10000);
          } else {//download file
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => window.URL.revokeObjectURL(url), 10000);
          }
        } else {
          showToast(result, 'error');
        }
      }

    } catch (error) {
      showToast(translations.Cv.CouldNotPreviewFile, "error");
    }
  }

    async function handleDeleteFile() {
        try {
          if(user?._id && user?.cvFileUrl){
            const result = await UserService.getInstance().removeMyCv();
    
            if (!isString(result)) {
                showToast(translations.Cv.DeletedFile, "success");
                setUser({...user,cvFileUrl:''})
            } else {
                showToast(result,'error');
            }
    
            initModal({ active: false });
          }
        } catch (error) {
            if(isString(error)){
                showToast(error,'error');
            }
        }
    }

    async function handleUploadFile(_userId: string,cvFilePath:string):  Promise<string | void>  {
        try {
            const result = await UserService.getInstance().updateMe({ cvFileUrl: cvFilePath });
            
            if (!isString(result)) {
                showToast(translations.Cv.CvFileUploaded, "success");
                if(user){
                  setUser({...user,cvFileUrl : result.user?.cvFileUrl || cvFilePath})
                }
            } else {
                showToast(result, "error");       
            }
        } catch (error) {
            if(isString(error)){
                showToast(error,'error');
            }
        }
    }

            const UploadCvModal = (userId: string, index: number) => {
                initModal({
                  active: true,
                  modalTitle: translations.Cv.UploadCv,
                  modalBody: (
                    <UploadFileModal
                      userId={userId}
                      index={index}
                      uploadFile={handleUploadFile}
                    />
                  ),
                  modalStyle: {
                    bodyClass: "height-35rem xs-h-22rem justify-content-center",
                    dialogClassName: " max-width-45rem",
                    titleClass: "font-RubikBold fs-1-25rem",
                  },
                  
                });
              };
        
  const fetchJobs = async () => {
    const { page, pageSize } = paginationModel;
    setLoading(true);

    const filters: { [key: string]: any } = {};
    if (search) filters.inputValue = search;

    if (selectedStatus.length > 0) {
      let finalSelectedStatus = [...selectedStatus];
      const includesClosed = selectedStatus.some(
        option => option.value === "Closed"
      );

      if (includesClosed) {
        finalSelectedStatus.push({ value: "Suspended", label: "מושהה" });
      }
      filters.jobStatus = finalSelectedStatus.map((x) => x.value);
    }
      

    if (sortConfig.field && sortConfig.sort) {
      filters.sortField = sortConfig.field;
      filters.sortOrder = sortConfig.sort;
    }

    try {
      if (user?._id) {
        const joblist = await JobService.getInstance().getJobApplications(
          user._id,
          {
            ...filters,
            page: page + 1,
            limit: pageSize
          }
        );
        if (!isString(joblist)) {
          setJobs(joblist.jobs);
          setTotalJobs(joblist.total);
        } else {
          showToast(joblist, 'error');
        }
      }
    } catch (error) {
      console.error("Error fetching jobs:", error);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchJobs();
  }, [paginationModel, search, sortConfig, selectedStatus]);

  useEffect(() => {
    setPaginationModel({page: 0, pageSize: 8})
  },[selectedStatus]);

  const handleSortChange = (field: string | null, sort: 'asc' | 'desc' | null) => {
    setSortConfig({ field, sort });
  };

  const handleSearchChange = (searchTerm: string) => {
    setSearch(searchTerm);
  };

  const onStatusSelectionChange = (selectedOptions: OptionType[]) => {
    setSelectedStatus(selectedOptions);
  };

  const clearSearch = () => {
    setSearch('');
  };

  const allColumns: Column<JobData>[] = [
    {
      key: 'title',
      hideHeaderOnMobile: true,
      className: 'min-w-20vh font-RubikSmall font-RubikSmall fs-14',
      valueClassName:'truncate', header: translations.Jobs.JobtTitle, sortable: true
    },
    { key: 'companyName', className: 'min-w-20vh font-RubikSmall fs-14 ', header: translations.Jobs.CompanyName },
    {
      key: 'publishDate', sortable: true, className: 'min-w-20vh font-RubikSmall fs-14', header: translations.Jobs.PublishDate,
      render: (job) => {
        return (
          <span>
            {formatDateToDisplay((job.publishDate).toString(), formatDateTranslations)}
          </span>
        );
      },
    },
    {
      key: 'location', className: 'min-w-20vh font-RubikSmall fs-14', header: translations.Jobs.Location,
      render: (job) => {
        return (
          <span>
            {job.location?.city}
          </span>
        )
      }

    },
    {
      key: 'updatedAt', className: 'min-w-20vh font-RubikSmall fs-14 ', header: translations.Jobs.SubmissionDate,
      render: (job) => {

        return (
          <span>
            {formatDateToDisplay((job.jobAppcreatedAt)?.toString(), formatDateTranslations)}
          </span>
        );
      },

    },
    {
      key: 'status',
      header: translations.Jobs.GeneralStatus,
      className: 'mobile-align-left',
      hideHeaderOnMobile: true,
      render: (job) => {
        const statusMap: Record<string, string> = {
          'Active': 'status-open',
          'Suspended': 'status-closed',
          'Closed': 'status-closed',
        };
        const statusClass = statusMap[job.status] || 'status-open';
        return (
          <span className={`status-tag ${statusClass} font-RubikMedium `}>
            {job.status === 'Active' ? translations.Jobs.openPosition : translations.Jobs.closedPosition}
          </span>
        );
      },
    },
  ];

  return (
    <div>
      {isCandidateUser(user) && <LegacyReadOnlyDetails onReadOnly={setReadOnly} />}
      {/* Several roles per account (23.11.2026): the same account can post jobs as an employer too. */}
      {isCandidateUser(user) && !isEmployerUser(user) && (
        <p className="small pt-2 mb-0"><a href={ClientRoutes.JoinAsEmployer}>הצטרפות גם כמעסיק (באותו חשבון)</a></p>
      )}
      {isCandidateUser(user) && !readOnly && (
        <div className="d-flex justify-content-center justify-content-md-end pt-3">
          <Button
            type="button"
            className="btn h-2-5rem text-color-dark-green border-color-dark-green-2-2px rounded-pill px-4"
            onClick={() => openEdit()}
          >
            <i className="bi bi-person-gear ms-2" aria-hidden="true" />
            {translations.Profile.EditButton}
          </Button>
        </div>
      )}
      <h1 className='pt-md-3 pb-4 font-EzerRegularLoft display-6 text-center text-md-end'>{translations.Jobs.MySubmittedJobs}</h1>
      <Row className="d-flex pb-3 pb-md-0 border-xs-only">
        <Col md={5} xs={12} className='d-flex justify-content-start ps-2'>
          <SearchBar
            searchTerm={search}
            setSearchTerm={handleSearchChange}
            handleSearch={fetchJobs}
            onClearSearchClick={() => clearSearch()}
            placeHolderText={translations.Jobs.SearchPosition}
            clearSearch={clearSearch}
          />
        </Col>
        <Col md={2} xs={5} className='d-flex justify-content-start pe-2 pt-3 pt-md-0'>
          <DropDown
            title={translations.Jobs.Status}
            options={statusOptions}
            selectedOptions={selectedStatus}
            onSelect={onStatusSelectionChange}
            onSearch={fetchJobs}
          />
        </Col>
        {user?.cvFileUrl ?
        <>
           <Col md={5} xs={7}  className="d-flex justify-content-end pt-3 pt-md-0">

           <Button
             type="button"
             className="btn h-2-5rem xs-h-2-2rem sm-h-3rem text-color-dark-green border-color-dark-green-2-2px rounded-pill width-7rem sm-w-7-5rem xs-w-6rem xs-fs-0-93rem "
             onClick={() => handlePreviewFile()}
           >
             {translations.Cv.ViewCV}
           </Button>
            {!readOnly && <Button
              type="button"
              className="btn h-2-5rem xs-h-2-2rem sm-h-3rem text-color-dark-green border-color-dark-green-2-2px rounded-pill width-7rem xs-w-6rem sm-w-7-5rem xs-fs-0-93rem mx-1 mx-lg-3"
              onClick={() => deleteCvModal()}
            >
              {translations.Cv.DeleteCV}
            </Button>}
          </Col> 
        </>
         :
         <Col md={5} xs={7} className="d-flex justify-content-end  pt-3 pt-md-0 ps-2">
         {!readOnly && <Button
           type="button"
           className="btn h-2-5rem xs-h-2-2rem sm-h-3rem  text-color-dark-green border-color-dark-green-2-2px rounded-pill width-7rem xs-w-6rem sm-w-7-5rem"
           onClick={() => {
            if(user?._id){
              UploadCvModal(user?._id,1)
           }}}
         >
           {translations.Cv.UploadCvShortcut}
         </Button>}
       </Col>
        }
      </Row>

      <div className={`pt-4 direction_en`}>
        <GenericTable
          columns={allColumns}
          rows={jobs}
          sortField={sortConfig.field}
          sortOrder={sortConfig.sort}
          handleSortChange={handleSortChange}
          paginationModel={paginationModel}
          setPaginationModel={setPaginationModel}
          total={totalJobs}
          onRowClick={handleRowClick}
        />
      </div>
    </div>
  );
};

export default JobsApplicationsManagement;