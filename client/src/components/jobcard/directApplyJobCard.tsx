import { Chip } from "@mui/material";
import { safeHtml } from '../../utils/safeHtml';
import { i18n } from "../../i18n/I18n";
import { BagIcon, ClockIcon, DocIcon, LocationIcon, MailIcon, PlanetIcon, ProfileIcon, UserIcon } from "../../icons";
import { JobData } from "../../models/interfaces/Props.interfaces";
import { formatDateToDisplay } from "../../utils/utils";
import JobInfo from "./JobInfo";
import { Colors } from "../../i18n/General.enums";

interface JobCardDataProps {
    jobData: JobData;
}

export const DirectApplyJobCard: React.FC<JobCardDataProps> = ({ jobData }) => {

    const translations = i18n.getTranslations();

    return (
        <div>
            <div className="row">
                <h3 className="font-RubikRegular fs-6">{translations.JobCard.manualApplicationInfo}</h3>
                <div className="col-12">
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
                            />
                        </div>
                    }

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
                </div>
            </div>
        </div>
    );
};
