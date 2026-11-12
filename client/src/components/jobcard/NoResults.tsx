import { i18n } from '../../i18n/I18n'

function NoResults() {
  const translations = i18n.getTranslations();
    return (
      <div className="text-center py-5">
      <img src={'/images/no_results.png'} />  
      <h4 className='font-EzerLightLoft  display-6 pt-5 pb-2'>{translations.NoResultsPage.NoResultsFound}</h4>
      <h4 className='font-RubikRegular' >{translations.NoResultsPage.SuggestionToChange}</h4>
      </div>  
    );
  }
  
  export default NoResults;