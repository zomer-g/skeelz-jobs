import React, { useEffect, useState } from 'react';
import { userProfile } from '../../models/interfaces/Props.interfaces';
import { getDefaultFilenameByMime, isString } from '../../utils/utils';
import useToastStore from '../../store/Toast.store';
import { i18n } from '../../i18n/I18n';
import { UserService } from '../../services/api/User.service';
import UsersTable from './UsersTable';
import { MARKETING_LABELS } from './MarketingStatus';
import GuestApplications from './GuestApplications';
import EmployerForwards from './EmployerForwards';
import SearchBar from '../common/SearchBar';
import CircularLoader from '../common/CircularLoader';
import { UploadFileService } from '../../services/api/UploadFile.service';
import useModalStore from '../../store/Modal.store';
import useUserStore from '../../store/User.store';
import { FormControlLabel } from '@mui/material';
import IOSSwitch from '../common/IosSwitch';
import useAuthStore from '../../store/Auth.store';
import { canManageContent } from '../../i18n/General.enums';
import { Link } from 'react-router-dom';
import { ClientRoutes } from '../../i18n/ClientRoutes.enum';

// Prepare options for the status dropdown
const translations = i18n.getTranslations();

// /users-management: candidates, for placement coordinators (view only), content managers and admins (staff users
// are at /staff-management). The sign-up form's settings are on the settings screen (/settings) since 23.11.2026.
const UsersManagement: React.FC = () => {
    const [search, setSearch] = useState('');
    const [paginationModel, setPaginationModel] = useState({ page: 0, pageSize:9 });
    const [totalUsers, setTotalUsers] = useState<number>(0);
    const { initModal } = useModalStore();
    const [sortConfig, setSortConfig] = useState<{ field: string | null; sort: 'asc' | 'desc' | null }>({
        field: null,
        sort: null
    });
    const [users, setUsers] = useState<userProfile[]>([]);
    const { showToast } = useToastStore();
    const [loading, setLoading] = useState(true);
    const [hasCv,setHasCv] = useState(false)
    const [hasApplied,setHasApplied] = useState(false)
    const [marketing, setMarketing] = useState('') // '' = all; agreed / not_agreed / removed / unknown
    const { user } = useAuthStore();
    const readOnly = !canManageContent(user?.role);


    useEffect(() => {
        fetchUsers(); 
    }, [paginationModel, search, sortConfig,hasApplied,hasCv,marketing]);

    // A new sort starts from the first page (same request, sortField / sortOrder).
    const handleSortChange = (field: string | null, sort: 'asc' | 'desc' | null) => {
        setSortConfig({ field, sort });
        setPaginationModel((m) => (m.page === 0 ? m : { ...m, page: 0 }));
    };

    const handleSearch = async () => {
        const userslist = await UserService.getInstance().fetchUsersListRequest({inputValue:search});   
        if(!isString(userslist)){
            setUsers(userslist.users) 
        }
        else{
            showToast(
                userslist,
              "error",
            )
        }
    };

    async function handleDeleteFile(cvFileUrl: string, userId: string) {
        try {
            const result = await UploadFileService.getInstance().deleteCV(cvFileUrl, userId);
    
            if (!isString(result)) {
                showToast(translations.Cv.DeletedFile, "success");
            } else {
                showToast(result,'error');
            }
    
            initModal({ active: false });
        } catch (error) {
            if(isString(error)){
                showToast(error,'error');
            }
        }
    }

    async function handleUploadFile(userId: string,cvFilePath:string):  Promise<string | void>  {
        try {

            const result = await UserService.getInstance().updateUserById(userId, { cvFileUrl: cvFilePath});
            
            if (!isString(result)) {
                showToast(translations.Cv.CvFileUploaded, "success");
            } else {
                showToast(result, "error");       
            }

        } catch (error) {
            if(isString(error)){
                showToast(error,'error');
            }
        }
    }


    async function handleDownloadFile(userId: string) {
        try {
            const result = await UploadFileService.getInstance().fetchCV(userId);
            
            if (!isString(result)) {
                const contentType = result.headers['content-type'] || 'application/octet-stream';
                const blob = new Blob([result.data], { type: contentType });
                const disposition = result.headers['content-disposition'];
                const match = disposition?.match(/filename="?([^"]+)"?/);
                const filename = match?.[1] || getDefaultFilenameByMime(contentType);
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.click();
                window.URL.revokeObjectURL(url);
                showToast(translations.Cv.DownloadedFile, "success");
            } else {
                showToast(result,'error');
            }

        } catch (error) {
            if(isString(error)){
                showToast(error,'error');
            }
        }
    }


    async function handlePreviewFile(userId: string) {
        try {
            const result = await UploadFileService.getInstance().fetchCV(userId);
        
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
            console.error('Error while loading file preview');
          }
      
        } catch (error) {
          console.error("Unexpected error:", error);
          showToast(translations.Cv.CouldNotPreviewFile, "error");
        }
      }

      const handlehasAppliedToggle = (checked: boolean) => {
        setHasApplied(checked);
      };

      const handlehasCvToggle = (checked: boolean) => {
        setHasCv(checked);
      };
    
    
    const fetchUsers = async () => {
        const { page, pageSize } = paginationModel;
        
        // Build filters dynamically based on non-empty values
        const filters: { [key: string]: any } = {};
        if (search) filters.inputValue = search;
        if(hasApplied) filters.hasApplied = hasApplied;
        if(hasCv) filters.hasCv = hasCv;
        if (marketing) filters.marketing = marketing;
        if (sortConfig.field && sortConfig.sort) {
            filters.sortField = sortConfig.field;
            filters.sortOrder = sortConfig.sort;
        }

        try {
            const userslist = await UserService.getInstance().fetchUsersListRequest({
                ...filters,
                page: page + 1, // Backend expects 1-based index
                limit: pageSize,
            });
            if (!isString(userslist)) {
                setUsers(userslist.users)
                setTotalUsers(userslist.total)
                setLoading(false); 
            } else {
                showToast(userslist,'error');
            }
        } catch (error) {
            console.error("Error fetching jobs:", error);
        } 
    };

    const clearSearch = () => {
        setSearch(''); 
      };


    return (
        // `users-admin`: the page may use more than Bootstrap's container width (App.scss "Candidates list").
        <div className="users-admin">
            <h1 className='pt-5 pb-4 font-EzerThinLoft fw-bold text-bold-black-2 display-6'>{translations.UserProfile.Users}</h1>
            {/* Search + the two filters: one row when it fits, wraps cleanly when it doesn't. */}
            <div className="users-admin__filters">
                <div className="users-admin__search">
                <SearchBar
                    clearSearch={clearSearch}
                    searchTerm={search}
                    setSearchTerm={setSearch}
                    handleSearch={handleSearch}
                    onClearSearchClick={() => clearSearch}
                    placeHolderText={translations.UserProfile.SearchUser}/>
                </div>
                <div className="users-admin__toggles">
                    <FormControlLabel
                        className="users-admin__toggle"
                        label={translations.UserProfile.hasAppliedToJob}
                        control={
                            <IOSSwitch
                                checked={hasApplied}
                                onChange={(_e, checked) => handlehasAppliedToggle(checked)}
                            />}
                    />
                    <FormControlLabel
                        className="users-admin__toggle"
                        label={translations.UserProfile.hasCv}
                        control={
                            <IOSSwitch
                                checked={hasCv}
                                onChange={(_e, checked) => handlehasCvToggle(checked)}
                            />}
                    />
                    <label className="users-admin__toggle d-inline-flex align-items-center gap-2" dir="rtl">
                        דיוור שיווקי
                        <select className="form-select form-select-sm w-auto" value={marketing} onChange={(e) => setMarketing(e.target.value)} data-testid="marketing-filter">
                            <option value="">הכול</option>
                            {(Object.keys(MARKETING_LABELS) as (keyof typeof MARKETING_LABELS)[]).map((k) => <option key={k} value={k}>{MARKETING_LABELS[k]}</option>)}
                        </select>
                    </label>
                </div>
            </div>
            <div className={`pt-4 direction_en ${loading ? 'd-none' : ''}`}>
                <UsersTable 
                users={users}
                handleSortChange = {handleSortChange}
                sortConfig = {sortConfig}
                paginationModel = {paginationModel}
                setPaginationModel = {setPaginationModel}
                totalUsers = {totalUsers}
                deleteFile = {handleDeleteFile}
                downloadFile = {handleDownloadFile}
                uploadFile = {handleUploadFile}
                previewFile = {handlePreviewFile}
                readOnly = {readOnly}
                onChanged = {fetchUsers}
                />
            </div>
            {loading && 
            <div className='pt-5'>
               {<CircularLoader/>}
            </div>
            }
            <GuestApplications readOnly={readOnly} />
            <EmployerForwards readOnly={readOnly} />
            {!readOnly && (
                <p dir="rtl" className="pt-4 font-RubikRegular">
                    שדות טופס ההרשמה והשאלות הנוספות נמצאים עכשיו ב<Link to={`${ClientRoutes.Settings}#settings-signup`}>מסך ההגדרות</Link>.
                </p>
            )}
        </div>
    );
};

export default UsersManagement;
