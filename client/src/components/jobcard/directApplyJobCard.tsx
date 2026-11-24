import { useEffect, useState } from "react";
import { JobService } from "../../services/api/Job.service";
import { safeHtml } from '../../utils/safeHtml';
import { i18n } from "../../i18n/I18n";
import { BagIcon, ClockIcon, DocIcon, LocationIcon, MailIcon, PlanetIcon, ProfileIcon, UserIcon } from "../../icons";
import { JobData } from "../../models/interfaces/Props.interfaces";
import { formatDateToDisplay } from "../../utils/utils";
import JobInfo from "./JobInfo";
import { Colors } from "../../i18n/General.enums";

interface JobCardDataProps {
    jobData: JobData;
    /** Inside the job page's "apply directly to the employer" box: contact lines only. */
    compact?: boolean;
}

type Contact = Pick<JobData, 'contactPersonName' | 'contactPersonPhone' | 'contactPersonEmail'>;

/**
 * The employer's details for a self-apply job (guest mode 'self'). The job lists (board, map, page data) carry no
 * contact details; they are fetched here from GET /api/jobs/:jobId, which sends contactPerson* to the public only
 * on such jobs (jobDAL.rowToJob). On other jobs this shows the title and company only.
 */
export const DirectApplyJobCard: React.FC<JobCardDataProps> = ({ jobData: listed, compact = false }) => {

    const translations = i18n.getTranslations();
    const [contact, setContact] = useState<Contact | null>(null);
    useEffect(() => {
        setContact(null);
        if (!listed?._id || listed.contactPersonName || listed.contactPersonPhone || listed.contactPersonEmail) return;
        let alive = true;
        JobService.getInstance().getJobById(String(listed._id)).then((r) => {
            if (!alive || !r || typeof r === 'string') return;
            const j: any = (r as any).data ?? r;
            setContact({ contactPersonName: j?.contactPersonName, contactPersonPhone: j?.contactPersonPhone, contactPersonEmail: j?.contactPersonEmail });
        }).catch(() => undefined);
        return () => { alive = false; };
    }, [listed?._id]);
    const jobData: JobData = contact ? { ...listed, ...contact } : listed;

    return (
        <div>
            <div className="row">
                {!compact && <h3 className="font-RubikRegular fs-6">{translations.JobCard.manualApplicationInfo}</h3>}
                <div className="col-12">
                    {!compact && <>
                    <div>
                        <JobInfo
                            icon={<DocIcon color={Colors.LightGrayB}/>}
                            title={translations.Jobs.JobtTitle}
                            info={jobData.title || ""}
                        />
                    </div>
                     <div>
                        <JobInfo
                            icon={<BagIcon color={Colors.LightGrayB}/>}
                            title={translations.Jobs.CompanyName}
                            info={jobData.companyName || ""}
                        />
                    </div>
                    </>}
                {jobData.contactPersonName &&
                    <div>
                        <JobInfo
                            icon={<ProfileIcon color={Colors.LightGrayB}/>}
                            title={translations.Jobs.ContactPersonName}
                            info={jobData.contactPersonName || ""}
                        />
                    </div>
                    }
                    {jobData.contactPersonPhone &&
                        <div>
                            <JobInfo
                                icon={<LocationIcon color={Colors.LightGrayB}/>}
                                title={translations.Jobs.Phone}
                                info={jobData?.contactPersonPhone || ""}
                            />
                        </div>
                    }
                    {jobData.contactPersonEmail &&
                        <div >
                            <JobInfo
                                icon={<MailIcon color={Colors.LightGrayB}/>}
                                title={translations.Jobs.Mail}
                                info={jobData?.contactPersonEmail || ""}
                                infoUrl={true}
                                noTruncate={compact}
                            />
                        </div>
                    }
                    {jobData.externalLink &&
                        <div >
                            <JobInfo
                                icon={<PlanetIcon />}
                                title={translations.Jobs.linkToApply}
                                info={jobData?.externalLink}
                                infoUrl={true}
                                noTruncate={compact}
                            />
                        </div>
                    }

                    {!compact && <>
                    <hr className="w-10 my-4" />
                    <h3 className="font-RubikRegular fs-6">{translations.JobCard.manualApplicationInstruction}</h3>
                    <div className="xxl-min-h-5vh">
                        <span
                            className="font-RubikBold fs-5"
                        >
                            {translations.JobCard.goodLuck}
                        </span>
                    </div>

                    <div className="xxl-min-w-80vh">
                        <span
                            className="font-RubikRegular"
                            dangerouslySetInnerHTML={{ __html: safeHtml(jobData.comments) }}
                        />
                    </div>
                    </>}
                </div>
            </div>
        </div>
    );
};
