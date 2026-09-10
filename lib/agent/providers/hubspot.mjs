// HubSpot adapter: private-app Bearer token, standard REST status codes (http.mjs classifies these on its own).
// Contract: sections 6 and 7.
import {ProviderError,request,retryRead} from '../http.mjs';

const BASE='https://api.hubapi.com';
const defaultProperties=config=>['email','firstname','lastname',config.hubspot.property];
const mapContact=c=>({id:c.id,email:c.properties?.email || '',firstName:c.properties?.firstname || '',lastName:c.properties?.lastname || '',properties:{...c.properties}});

export function createHubspot({config,fetchImpl=fetch}={}){
  const auth={Authorization:`Bearer ${config.hubspot.token}`};
  async function get(path,label){
    return await retryRead(async()=>{
      const res=await request({url:`${BASE}${path}`,method:'GET',headers:auth,fetchImpl,label:`HubSpot ${label}`});
      return res.json;
    },{});
  }
  async function post(path,body,label){
    return await retryRead(async()=>{
      const res=await request({url:`${BASE}${path}`,method:'POST',headers:auth,body,fetchImpl,label:`HubSpot ${label}`});
      return res.json;
    },{});
  }
  async function patch(path,body,label){
    const res=await request({url:`${BASE}${path}`,method:'PATCH',headers:auth,body,fetchImpl,label:`HubSpot ${label}`});
    return res.json;
  }
  return {
    async health(){await get('/crm/v3/objects/contacts?limit=1','health check');return {ok:true};},
    // Filters, exact: email EQ '<email>' when an email is given; else email CONTAINS_TOKEN '*@<domain>'; else a
    // free-text query across HubSpot's default searchable properties.
    async findContact({email='',domain='',query=''}={}){
      const properties=defaultProperties(config);
      let body;
      if(email) body={filterGroups:[{filters:[{propertyName:'email',operator:'EQ',value:email}]}],properties,limit:10};
      else if(domain) body={filterGroups:[{filters:[{propertyName:'email',operator:'CONTAINS_TOKEN',value:`*@${domain}`}]}],properties,limit:10};
      else if(query) body={query,properties,limit:10};
      else throw new ProviderError('INVALID','Provide an email, domain or query to search HubSpot contacts.',{});
      const json=await post('/crm/v3/objects/contacts/search',body,'contact search');
      return (json.results || []).map(mapContact);
    },
    async getContact({id,properties}={}){
      const props=(properties && properties.length?properties:defaultProperties(config)).join(',');
      return mapContact(await get(`/crm/v3/objects/contacts/${encodeURIComponent(id)}?properties=${encodeURIComponent(props)}`,'contact'));
    },
    async updateContact({id,properties}={}){
      return mapContact(await patch(`/crm/v3/objects/contacts/${encodeURIComponent(id)}`,{properties},'update contact'));
    }
  };
}
