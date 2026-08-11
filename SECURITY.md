# Politique de sécurité

## Versions prises en charge

Le projet est actuellement en développement initial. Seul le dernier état de la branche `main`
reçoit des correctifs de sécurité.

## Signaler une vulnérabilité

N'ouvrez pas d'issue ou de pull request publique contenant une vulnérabilité, un exploit ou un
secret. Utilisez plutôt le bouton **Report a vulnerability** dans l'onglet **Security** du dépôt :

https://github.com/alexisdechiara/fitness-mcp/security/advisories/new

Indiquez, lorsque c'est possible, l'impact, les étapes de reproduction, la version ou le commit
concerné et une piste de correction. Ne joignez jamais de credentials de production.

## Secret exposé

Considérez tout secret commité comme compromis : révoquez-le ou faites-le tourner immédiatement,
puis retirez-le du dépôt et de tout l'historique publié. La suppression du seul fichier courant ne
suffit pas.
